import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { useMachinePresenceCounts } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';

afterEach(() => {
    clearMachineRequestReachabilityForTest();
    standardCleanup();
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
    it('moves a machine offline on a failed request and does not recover on a subsequent heartbeat', async () => {
        const previousState = storage.getState();
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const serverId = String(getActiveServerSnapshot().serverId ?? '').trim() || 'server-active';
        const now = Date.now();
        try {
            publishAppliedActiveServerSnapshot({ ...getActiveServerSnapshot(), serverId });
            storage.setState({ profileScope: { serverId, accountId: 'account' } });
            setHomeMachines([machine('laptop', { activeAt: now })]);
            const hook = await renderHook(() => useMachinePresenceCounts(), { flushOptions: { cycles: 1, turns: 4 } });
            expect(hook.getCurrent()).toEqual({ online: 1, offline: 0 });

            await act(async () => {
                recordMachineRequestFailed({ serverId, machineId: 'laptop', observedAtMs: now + 1 });
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
