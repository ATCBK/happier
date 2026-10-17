import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';

const home = createHomeGovernanceHarness();
const homeIdentityId = 'srv_counts';
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
const { useMachinePresenceCounts } = await import('@/sync/domains/state/storage');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');

beforeEach(async () => {
    await loadSyncSingletonForTests();
    await home.reset();
    await home.addHome({ name: 'Counts Home', serverUrl: 'https://counts.example.test',
        serverIdentityId: homeIdentityId, accountId: 'account' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ profileScope: { serverId: homeIdentityId, accountId: 'account' } });
});

afterEach(async () => {
    clearMachineRequestReachabilityForTest();
    standardCleanup();
    vi.useRealTimers();
    await home.reset();
});

const DAY_MS = 24 * 60 * 60 * 1000;

function machine(id: string, overrides: Partial<Machine> = {}): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1000,
        updatedAt: 1000,
        active: true,
        activeAt: Date.now(),
        metadata: { host: id, platform: 'darwin', happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home' },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 0,
        revokedAt: null,
        ...overrides,
    };
}

function setHomeMachines(machines: readonly Machine[]) {
    const activeServerId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
    storage.setState((state) => ({
        ...state,
        machines: {},
        machineListByServerId: { ...state.machineListByServerId, [activeServerId]: [...machines] },
    }));
}

describe('useMachinePresenceCounts', () => {
    it('expires the chrome count at the same grace boundary without another store write', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        setHomeMachines([machine('laptop')]);
        const hook = await renderHook(() => useMachinePresenceCounts());
        expect(hook.getCurrent()).toEqual({ online: 1, offline: 0 });
        await act(async () => { vi.advanceTimersByTime(60_001); });
        expect(hook.getCurrent()).toEqual({ online: 0, offline: 1 });
        await hook.unmount();
    });

    it('recovers on a real heartbeat after grace expiry even when the raw Machine containers retain their identity', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        vi.setSystemTime(Date.now());
        const serverId = getActiveServerSnapshot().serverId;
        storage.getState().applyMachines([machine('laptop')], true, { sourceServerId: serverId, sourceAccountId: 'account' });
        storage.getState().markMachineListSettled(serverId);
        const hook = await renderHook(() => useMachinePresenceCounts());
        try {
            expect(hook.getCurrent()).toEqual({ online: 1, offline: 0 });
            await act(async () => { vi.advanceTimersByTime(60_001); });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 1 });
            const before = storage.getState();
            await act(async () => {
                storage.getState().applyMachines([machine('laptop')], false, { sourceServerId: serverId, sourceAccountId: 'account' });
            });
            expect(storage.getState().machines).toBe(before.machines);
            expect(storage.getState().machineListByServerId).toBe(before.machineListByServerId);
            expect(hook.getCurrent()).toEqual({ online: 1, offline: 0 });
        } finally { await hook.unmount(); }
    });

    it('moves a machine offline on a failed request and does not recover on a subsequent heartbeat', async () => {
        const previousState = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
        const now = Date.now();
        try {
            // Request observations belong to the authenticated Home; retain the real scope owners.
            publishAppliedActiveServerSnapshot({ ...getActiveServerSnapshot(), serverId });
            storage.setState({ profileScope: { serverId, accountId: 'account' } });
            setHomeMachines([machine('laptop', { activeAt: now })]);
            const hook = await renderHook(() => useMachinePresenceCounts(), { flushOptions: { cycles: 1, turns: 4 } });
            expect(hook.getCurrent()).toEqual({ online: 1, offline: 0 });

            await act(async () => {
                recordMachineRequestFailed({ serverId: homeIdentityId, accountId: 'account', machineId: 'laptop', observedAtMs: now + 1 });
            });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 1 });
            await act(async () => {
                setHomeMachines([machine('laptop', { activeAt: now + 2 })]);
            });
            expect(hook.getCurrent()).toEqual({ online: 0, offline: 1 });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        }
    });

    it('counts the Home machines online and offline, leaving out revoked and replaced identities', async () => {
        const previousState = storage.getState();
        try {
            setHomeMachines([
                machine('laptop'),
                machine('devbox'),
                machine('studio', { active: false, activeAt: Date.now() - 2 * DAY_MS }),
                machine('gone', { revokedAt: Date.now() }),
                // An identity replaced by a newer one (a reinstall) is not a machine that is offline.
                machine('old-laptop', { active: false, activeAt: Date.now() - 9 * DAY_MS, replacedByMachineId: 'laptop' }),
            ]);
            const hook = await renderHook(() => useMachinePresenceCounts(), { flushOptions: { cycles: 1, turns: 4 } });

            expect(hook.getCurrent()).toEqual({ online: 2, offline: 1 });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('keeps the closed summary still while machines change without changing the counts, and follows a presence change', async () => {
        const previousState = storage.getState();
        try {
            setHomeMachines([machine('laptop'), machine('studio', { active: false, activeAt: Date.now() - 2 * DAY_MS })]);
            let renders = 0;
            const hook = await renderHook(() => {
                renders += 1;
                return useMachinePresenceCounts();
            }, { flushOptions: { cycles: 1, turns: 4 } });
            const first = hook.getCurrent();
            const rendersBefore = renders;

            // A heartbeat and a metadata edit: every machine object is replaced, the counts are not.
            await act(async () => {
                setHomeMachines([
                    machine('laptop', { activeAt: Date.now(), metadataVersion: 2 }),
                    machine('studio', { active: false, activeAt: Date.now() - 2 * DAY_MS, updatedAt: 2000 }),
                ]);
            });
            expect(renders).toBe(rendersBefore);
            expect(hook.getCurrent()).toBe(first);

            // Studio wakes up: the summary follows.
            await act(async () => {
                setHomeMachines([machine('laptop'), machine('studio')]);
            });
            expect(hook.getCurrent()).toEqual({ online: 2, offline: 0 });
            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
