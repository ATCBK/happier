import * as React from 'react';
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { LocalServiceLauncherSnapshotClient } from './useLocalServiceLauncherState';
import type { LocalServiceLauncherSnapshot } from './types';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const machineRpc = await import('./machineRpc');
const inventoryMachineRpc = await import('../inventory/machineRpc');
const { resetLocalServiceLauncherStoreForTests } = await import('./sharedStore');
const { resetLocalServiceInventoryStoreForTests } = await import('../inventory/sharedStore');
const { RetainedPanelSurface } = await import('@/components/ui/panels/RetainedPanelSurface');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { useLocalServiceLauncherStateController } = await import('./useLocalServiceLauncherState');

const initialSnapshot = {
    v: 1,
    machineId: 'machine-a',
    sessionId: 'session-a',
    updatedAt: 1_000,
    targets: [{
        id: 'managed:preview',
        source: 'managed_service',
        sourceClass: { kind: 'managed_service', managedServiceId: 'preview' },
        machineId: 'machine-a',
        sessionId: 'session-a',
        title: 'Preview',
        confidence: 'medium',
        state: 'available',
        actions: ['start'],
    }],
} satisfies LocalServiceLauncherSnapshot;

const startedSnapshot = {
    ...initialSnapshot,
    updatedAt: 2_000,
    targets: [{
        ...initialSnapshot.targets[0],
        state: 'starting',
        actions: [],
    }],
} satisfies LocalServiceLauncherSnapshot;

async function createHookHome() {
    const { createPlainArtifactHomeFixture } = await import('@/dev/testkit/harness/artifactStoreBoundary');
    const home = await createPlainArtifactHomeFixture('https://launcher-state.example.test', { accountId: 'account-a' });
    onTestFinished(() => home.dispose());
    return home.home.id;
}

describe('useLocalServiceLauncherState', () => {
    beforeEach(() => {
        // Launcher readiness follows genuine inventory transport, even with an injected launcher reader.
        vi.spyOn(inventoryMachineRpc, 'fetchLocalServiceInventorySnapshotViaMachineRpc').mockResolvedValue({
            ok: true,
            snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [] },
        });
        vi.spyOn(inventoryMachineRpc, 'watchLocalServiceInventorySnapshotViaMachineRpc')
            .mockImplementation(async () => new Promise(() => {}));
    });
    afterEach(async () => {
        await standardCleanup();
        resetLocalServiceLauncherStoreForTests();
        resetLocalServiceInventoryStoreForTests();
        vi.restoreAllMocks();
    });

    it('keeps qualified cached rows without hidden demand and retires real credential reads', async () => {
        const serverUrl = 'https://launcher-retained.example.test';
        const connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId: 'srv_launcher_retained' });
        onTestFinished(() => connection.dispose());
        const watchSignals: AbortSignal[] = [];
        vi.spyOn(inventoryMachineRpc, 'watchLocalServiceInventorySnapshotViaMachineRpc').mockImplementation(async input => {
            if (input.signal) watchSignals.push(input.signal);
            return new Promise(() => {});
        });
        const inventorySnapshotClient = vi.fn(async () => ({ ok: true as const, snapshot: {
            v: 1 as const, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle' as const, entries: [], diagnostics: [],
        } }));
        const pending = createDeferred<Awaited<ReturnType<LocalServiceLauncherSnapshotClient>>>();
        let deferAccountA = false;
        const pendingSignals: AbortSignal[] = [];
        const snapshotClient = vi.fn<LocalServiceLauncherSnapshotClient>(async input => {
            if (input.accountId === 'account-b') return { ok: true, snapshot: { ...initialSnapshot, updatedAt: 3_000,
                targets: [{ ...initialSnapshot.targets[0]!, title: 'Account B preview' }] } };
            if (deferAccountA) {
                if (input.signal) pendingSignals.push(input.signal);
                return pending.promise;
            }
            return { ok: true, snapshot: initialSnapshot };
        });
        let latest: ReturnType<typeof useLocalServiceLauncherStateController> | undefined;
        function Probe() {
            latest = useLocalServiceLauncherStateController({ machineId: 'machine-a', serverId: connection.serverId,
                sessionId: 'session-a', snapshotClient, inventorySnapshotClient });
            return null;
        }
        const frame = (active: boolean) => <RetainedPanelSurface isActive={active}><Probe /></RetainedPanelSurface>;
        const screen = await renderScreen(frame(false));
        expect(snapshotClient).not.toHaveBeenCalled();
        expect(inventorySnapshotClient).not.toHaveBeenCalled();
        await screen.update(frame(true));
        await vi.waitFor(() => expect(latest?.state.updatedAt).toBe(1_000));
        await vi.waitFor(() => expect(watchSignals).toHaveLength(1));
        await flushHookEffects();
        const initialReads = vi.mocked(snapshotClient).mock.calls.length;
        await screen.update(frame(false));
        expect(watchSignals[0]?.aborted).toBe(true);
        expect(latest?.state.targetsById.get('managed:preview')?.title).toBe('Preview');
        const closedInventoryReads = inventorySnapshotClient.mock.calls.length;
        await flushHookEffects();
        expect(snapshotClient).toHaveBeenCalledTimes(initialReads);
        expect(inventorySnapshotClient).toHaveBeenCalledTimes(closedInventoryReads);
        deferAccountA = true;
        await screen.update(frame(true));
        expect(latest?.state.targetsById.get('managed:preview')?.title).toBe('Preview');
        await vi.waitFor(() => expect(snapshotClient).toHaveBeenCalledTimes(initialReads + 1));
        const retiredApplySnapshot = latest!.applySnapshot;
        await act(async () => {
            expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: connection.serverId }, {
                token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature`,
            })).toBe(true);
        });
        await vi.waitFor(() => expect(pendingSignals[0]?.aborted).toBe(true));
        await vi.waitFor(() => expect(latest?.state.targetsById.get('managed:preview')?.title).toBe('Account B preview'));
        await act(async () => {
            retiredApplySnapshot(startedSnapshot);
            pending.resolve({ ok: true, snapshot: startedSnapshot });
        });
        await flushHookEffects();
        expect(latest?.state.updatedAt).toBe(3_000);
        expect(latest?.state.targetsById.get('managed:preview')?.title).toBe('Account B preview');
        await screen.unmount();
        expect(watchSignals.every(signal => signal.aborted)).toBe(true);
    });

    it('drives the machine-RPC launcher reader when no snapshot client is injected', async () => {
        const serverId = await createHookHome();
        const mod = await import('./useLocalServiceLauncherState');

        const spy = vi.spyOn(machineRpc, 'fetchLocalServiceLauncherSnapshotViaMachineRpc')
            .mockResolvedValue({ ok: false, reason: 'unavailable' });
        await renderHook(() => mod.useLocalServiceLauncherStateController({
            machineId: 'machine-a',
            serverId,
            sessionId: 'session-a',
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(spy).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-a',
            serverId,
        }));
    });

    it('lets the launcher state owner replace state from a successful Start response snapshot', async () => {
        await createHookHome();
        const mod = await import('./useLocalServiceLauncherState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceLauncherStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceLauncherStateController) return;

        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: initialSnapshot,
        })) satisfies LocalServiceLauncherSnapshotClient;
        const hook = await renderHook(() => mod.useLocalServiceLauncherStateController({
            machineId: 'machine-a',
            sessionId: 'session-a',
            snapshotClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(store.selectLocalServiceLaunchTargets(hook.getCurrent().state)).toEqual(initialSnapshot.targets);

        await act(async () => {
            hook.getCurrent().applySnapshot(startedSnapshot);
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(store.selectLocalServiceLaunchTargets(hook.getCurrent().state)).toEqual(startedSnapshot.targets);
    });

    it('ignores externally applied Start snapshots for a different session', async () => {
        await createHookHome();
        const mod = await import('./useLocalServiceLauncherState').catch(() => null);
        const store = await import('./store');

        expect(mod?.useLocalServiceLauncherStateController).toBeTypeOf('function');
        if (!mod?.useLocalServiceLauncherStateController) return;

        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: initialSnapshot,
        })) satisfies LocalServiceLauncherSnapshotClient;
        const hook = await renderHook(() => mod.useLocalServiceLauncherStateController({
            machineId: 'machine-a',
            sessionId: 'session-a',
            snapshotClient,
        }));
        await flushHookEffects({ cycles: 2, turns: 2 });
        const otherSessionSnapshot = {
            ...startedSnapshot,
            sessionId: 'session-b',
        } satisfies LocalServiceLauncherSnapshot;

        await act(async () => {
            hook.getCurrent().applySnapshot(otherSessionSnapshot);
        });
        await flushHookEffects({ cycles: 1, turns: 1 });

        expect(store.selectLocalServiceLaunchTargets(hook.getCurrent().state)).toEqual(initialSnapshot.targets);
    });
});
