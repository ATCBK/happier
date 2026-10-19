import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { flushHookEffects } from '@/dev/testkit';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), launcher: vi.fn() }));
// Daemon transport is the boundary; subscription, request and response owners remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});

import { expectNoWallClockPolling } from '../noPollingTestHelpers';
import {
    getLocalServiceLauncherState,
    publishLocalServiceLauncherSnapshot,
    resetLocalServiceLauncherStoreForTests,
    subscribeLocalServiceLauncherStore,
} from './sharedStore';
import { selectLocalServiceLaunchTargets } from './store';
import { resetLocalServiceInventoryStoreForTests } from '../inventory/sharedStore';
import { createLocalServicesRuntimeActionExecutor } from '../actions/runtimeActionExecutor';
import { LocalServiceActionRequestV1Schema, LocalServiceActionResultV1Schema } from '@happier-dev/protocol/local/services/actions/v1';

const snapshot = LocalServiceLauncherSnapshotV1Schema.parse({
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
});

async function flushMicrotasks(): Promise<void> {
    await flushHookEffects();
}

describe('shared local-service launcher store', () => {
    beforeEach(() => {
        rpc.launcher.mockReset();
        rpc.machine.mockReset().mockImplementation(async (request: { method: string }) => {
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
                return { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: 1_000,
                    refreshState: 'idle', entries: [], diagnostics: [] } };
            }
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) return { ok: false };
            return rpc.launcher(request);
        });
    });
    afterEach(() => {
        resetLocalServiceLauncherStoreForTests();
        resetLocalServiceInventoryStoreForTests();
    });

    it('refreshes all launcher projections after external runtime changes without a mounted surface refresh', async () => {
        const watches: Array<(value: unknown) => void> = [];
        let generation = 1_000;
        let running = true;
        rpc.machine.mockImplementation(async (request: { method: string; payload: { projection?: string; workspaceRoot?: string } }) => {
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                return await new Promise(resolve => watches.push(resolve));
            }
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
                return { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: generation,
                    refreshState: 'idle', entries: [], diagnostics: [] } };
            }
            return { protocolVersion: 1, snapshot: { ...snapshot, updatedAt: generation,
                targets: snapshot.targets.map(target => ({ ...target, serviceState: running ? 'healthy' : 'stopped' })) } };
        });
        const source = { machineId: 'machine-a', serverId: 'server-a', scope: 'workspace' as const, workspaceRoot: '/repo' };
        const bindings = { ...source, projection: 'managed_bindings' as const, accountId: 'owner' };
        const otherHome = { ...source, serverId: 'server-b' };
        const dispose = [source, bindings, otherHome].map(key => subscribeLocalServiceLauncherStore(key, () => {}));
        await vi.waitFor(() => expect(watches.length).toBeGreaterThanOrEqual(2));
        await flushMicrotasks();
        running = false;
        generation = 2_000;
        // An inventory watch is shared by every launcher projection on this Home/Machine.
        watches[0]!({ protocolVersion: 1, changed: true, snapshot: { v: 1, machineId: 'machine-a', generatedAt: generation,
            refreshState: 'idle', entries: [], diagnostics: [] } });
        await vi.waitFor(() => expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(source))[0]?.serviceState).toBe('stopped'));
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(bindings))[0]?.serviceState).toBe('stopped');
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(otherHome))[0]?.serviceState).toBe('healthy');
        dispose.forEach(unsubscribe => unsubscribe());
    });

    it('shares the initial launcher and completed-scan reads regardless of how many consumers subscribe', async () => {
        const snapshotClient = rpc.launcher.mockResolvedValue({
            protocolVersion: 1,
            snapshot,
        });
        const key = {
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
            scope: 'workspace' as const,
            workspaceRoot: '/repo',
        };

        const unsubA = subscribeLocalServiceLauncherStore(key, () => {});
        const unsubB = subscribeLocalServiceLauncherStore(key, () => {});
        await flushMicrotasks();

        expect(snapshotClient).toHaveBeenCalledTimes(2);
        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            serverId: 'server-a', payload: { machineId: 'machine-a', sessionId: 'session-a', scope: 'workspace', workspaceRoot: '/repo' },
        }));
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(snapshot.targets);

        unsubA();
        unsubB();
    });

    it.each(['server-a', undefined])('recovers failed projections after same-generation Action Refresh only on its Home (%s)', async serverId => {
        let available = false;
        rpc.launcher.mockImplementation(async (request: { payload: { workspaceRoot?: string } }) => {
            if (!available && request.payload.workspaceRoot !== '/healthy') throw new Error('temporarily unavailable');
            return { protocolVersion: 1, snapshot };
        });
        const source = { machineId: 'machine-a', serverId, scope: 'workspace' as const, workspaceRoot: '/repo' };
        const bindings = { ...source, projection: 'managed_bindings' as const, accountId: 'owner' };
        const otherHome = { ...source, serverId: 'server-b' };
        const healthy = { ...source, workspaceRoot: '/healthy' };
        const dispose = [source, bindings, otherHome, healthy].map(key => subscribeLocalServiceLauncherStore(key, () => {}));
        try {
            await vi.waitFor(() => {
                for (const key of [source, bindings, otherHome]) expect(getLocalServiceLauncherState(key).refreshStatus).toBe('error');
                expect(getLocalServiceLauncherState(healthy).refreshStatus).toBe('idle');
            });
            const previousHealthy = getLocalServiceLauncherState(healthy);
            available = true;
            const execute = createLocalServicesRuntimeActionExecutor({ request: async () => new Response(JSON.stringify({
                v: 1, machineId: 'machine-a', generatedAt: 1_000, refreshState: 'idle', entries: [], diagnostics: [],
            })) });
            await execute({ actionId: 'localServices.inventory.refresh', context: { surface: 'ui', serverId }, input: { machineId: 'machine-a' } });
            await vi.waitFor(() => {
                for (const key of [source, bindings]) expect(getLocalServiceLauncherState(key).refreshStatus).toBe('idle');
            });
            expect(getLocalServiceLauncherState(otherHome).refreshStatus).toBe('error');
            expect(getLocalServiceLauncherState(healthy)).toBe(previousHealthy);
        } finally { dispose.forEach(unsubscribe => unsubscribe()); }
    });

    it('refreshes and restores a retired inventory watch after a successful Stop through the Action owner', async () => {
        let running = true;
        let generation = 1_000;
        let watches = 0;
        rpc.machine.mockImplementation(async (request: { method: string }) => {
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_WATCH) {
                if (++watches === 1) return { ok: false };
                return await new Promise(() => {});
            }
            if (request.method === RPC_METHODS.DAEMON_LOCAL_SERVICES_INVENTORY_REFRESH) {
                return { protocolVersion: 1, snapshot: { v: 1, machineId: 'machine-a', generatedAt: generation,
                    refreshState: 'idle', entries: [], diagnostics: [] } };
            }
            return { protocolVersion: 1, snapshot: { ...snapshot, updatedAt: generation,
                targets: snapshot.targets.map(target => ({ ...target, serviceState: running ? 'healthy' : 'stopped' })) } };
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', scope: 'workspace' as const, workspaceRoot: '/repo' };
        const unsubscribe = subscribeLocalServiceLauncherStore(key, () => {});
        await vi.waitFor(() => expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))[0]?.serviceState).toBe('healthy'));
        expect(watches).toBe(1);
        const execute = createLocalServicesRuntimeActionExecutor({ request: async (_path, init) => {
            const request = LocalServiceActionRequestV1Schema.parse(JSON.parse(String(init?.body)));
            running = false;
            generation = 2_000;
            return new Response(JSON.stringify(LocalServiceActionResultV1Schema.parse({ v: 1,
                requestId: request.requestId, action: request.action, status: 'succeeded', auditEvents: [{ v: 1,
                    eventId: 'stopped', requestId: request.requestId, action: request.action, machineId: request.target.machineId,
                    result: 'succeeded', recordedAt: generation }] })), { status: 200 });
        } });
        const result = await execute({ actionId: 'localServices.actions.stopManaged', context: { serverId: 'server-a', surface: 'ui' },
            input: { requestId: 'stop-preview', action: 'stop_managed', target: { kind: 'managed_service', machineId: 'machine-a',
                managedServiceId: 'preview' } } });
        expect(result).toMatchObject({ status: 'succeeded' });
        await vi.waitFor(() => expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))[0]?.serviceState).toBe('stopped'));
        expect(watches).toBe(2);
        unsubscribe();
    });

    it('publishes action snapshots into the same backing model without polling', async () => {
        const snapshotClient = rpc.launcher.mockResolvedValue({
            protocolVersion: 1,
            snapshot: { ...snapshot, targets: [] },
        });
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a' };
        const listener = vi.fn();

        const unsub = subscribeLocalServiceLauncherStore(key, listener);
        await flushMicrotasks();
        listener.mockClear();

        publishLocalServiceLauncherSnapshot(key, snapshot);

        expect(listener).toHaveBeenCalled();
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(snapshot.targets);
        expect(snapshotClient).toHaveBeenCalledTimes(2);

        unsub();
    });

    it('re-reads scoped projections when an Action publishes a broader launcher snapshot', async () => {
        let generation = 1_000;
        rpc.launcher.mockImplementation(async () => ({ protocolVersion: 1, snapshot: { ...snapshot, updatedAt: generation } }));
        const key = { machineId: 'machine-a', serverId: 'server-a', sessionId: 'session-a',
            scope: 'workspace' as const, workspaceRoot: '/repo' };
        const unsubscribe = subscribeLocalServiceLauncherStore(key, () => {});
        await flushMicrotasks();
        generation = 2_000;
        publishLocalServiceLauncherSnapshot({ machineId: 'machine-a', serverId: 'server-a' }, {
            ...snapshot, updatedAt: 2_000, targets: [],
        });
        await flushMicrotasks();
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(snapshot.targets);
        expect(getLocalServiceLauncherState(key).updatedAt).toBe(2_000);
        unsubscribe();
    });

    it('does not re-fetch launch targets on a wall clock while subscribed', async () => {
        const snapshotClient = rpc.launcher.mockResolvedValue({
            protocolVersion: 1,
            snapshot,
        });
        const key = {
            machineId: 'machine-a',
            serverId: 'server-a',
            sessionId: 'session-a',
            scope: 'workspace' as const,
            workspaceRoot: '/repo',
        };

        await expectNoWallClockPolling({
            subscribe: () => subscribeLocalServiceLauncherStore(key, () => {}),
            fetchSpy: snapshotClient,
        });
    });
});
