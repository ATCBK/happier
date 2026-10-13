import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalServiceLauncherSnapshotV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { flushHookEffects } from '@/dev/testkit';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
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
    beforeEach(() => rpc.machine.mockReset());
    afterEach(() => {
        resetLocalServiceLauncherStoreForTests();
    });

    it('fetches once for a key regardless of how many consumers subscribe', async () => {
        const snapshotClient = rpc.machine.mockResolvedValue({
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

        expect(snapshotClient).toHaveBeenCalledTimes(1);
        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
            serverId: 'server-a', payload: { machineId: 'machine-a', sessionId: 'session-a', scope: 'workspace', workspaceRoot: '/repo' },
        }));
        expect(selectLocalServiceLaunchTargets(getLocalServiceLauncherState(key))).toEqual(snapshot.targets);

        unsubA();
        unsubB();
    });

    it('publishes action snapshots into the same backing model without polling', async () => {
        const snapshotClient = rpc.machine.mockResolvedValue({
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
        expect(snapshotClient).toHaveBeenCalledTimes(1);

        unsub();
    });

    it('does not re-fetch launch targets on a wall clock while subscribed', async () => {
        const snapshotClient = rpc.machine.mockResolvedValue({
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
