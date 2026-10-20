import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';
import { useHasMachineForGettingStartedGuidance } from './useHasMachineForGettingStartedGuidance';
import { useSessionGettingStartedGuidanceBaseModel } from './useSessionGettingStartedGuidanceBaseModel';

afterEach(() => {
    standardCleanup();
});

function activeServerId(): string {
    return String(getActiveServerSnapshot().serverId ?? '').trim();
}

describe('useHasMachineForGettingStartedGuidance', () => {
    it('keeps setup consumers quiet across resource-only revisions while observing removal', async () => {
        const previousState = storage.getState();
        let unmount: (() => Promise<void>) | undefined;
        try {
            const serverId = activeServerId();
            storage.setState({ isDataReady: true, machines: {}, machineListByServerId: {},
                machineListStatusByServerId: {}, machinePresenceById: {}, machinePresenceByServerId: {} });
            let machine = createMachineFixture({ id: 'guidance-resource-ticks', activeAt: Date.now(),
                daemonState: { contributionRegistryProjectionRevision: 1 },
                keyBasis: { dataEncryptionKey: null, metadataVersion: 1, daemonStateVersion: 1 } });
            storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
            storage.getState().markMachineListSettled(serverId);
            let renders = 0;
            const hook = await renderHook(() => {
                renders++;
                return { hasMachine: useHasMachineForGettingStartedGuidance(), model: useSessionGettingStartedGuidanceBaseModel() };
            });
            unmount = hook.unmount;
            expect(hook.getCurrent().hasMachine).toBe(true);
            const initialRenders = renders;
            for (let index = 0; index < 5; index++) {
                machine = { ...machine, seq: machine.seq + 1, daemonStateVersion: machine.daemonStateVersion + 1,
                    keyBasis: { ...machine.keyBasis!, daemonStateVersion: machine.daemonStateVersion + 1 },
                    activeAt: Date.now(), updatedAt: Date.now() };
                await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            }
            expect(renders - initialRenders).toBe(0);
            expect(storage.getState().machines[machine.id]?.daemonStateVersion).toBe(6);
            await act(async () => storage.getState().applyMachines([{ ...machine, revokedAt: Date.now() }], false, { sourceServerId: serverId }));
            expect(hook.getCurrent().hasMachine).toBe(false);
        } finally {
            await unmount?.();
            await act(async () => storage.setState(previousState));
        }
    });
    it('is undecided (null) until the active Home machine list has loaded', async () => {
        const previousState = storage.getState();
        try {
            expect(activeServerId()).not.toBe('');
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: {},
                machineListStatusByServerId: {},
            }));

            const hook = await renderHook(() => useHasMachineForGettingStartedGuidance(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBeNull();

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('is unsatisfied once the loaded machine list is empty', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {},
                machineListByServerId: { [activeServerId()]: [] },
                machineListStatusByServerId: {},
            }));

            const hook = await renderHook(() => useHasMachineForGettingStartedGuidance(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(false);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('is satisfied by a single OFFLINE machine (online state is irrelevant)', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {
                    'm-offline': createMachineFixture({ id: 'm-offline', active: false }),
                },
                machineListByServerId: {},
                machineListStatusByServerId: {},
            }));

            const hook = await renderHook(() => useHasMachineForGettingStartedGuidance(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(true);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });

    it('ignores revoked machines (a revoked-only account still needs machine setup)', async () => {
        const previousState = storage.getState();
        try {
            storage.setState((state) => ({
                ...state,
                isDataReady: true,
                machines: {
                    'm-revoked': createMachineFixture({ id: 'm-revoked', revokedAt: 1700000000000 }),
                },
                machineListByServerId: {
                    [activeServerId()]: [createMachineFixture({ id: 'm-revoked', revokedAt: 1700000000000 })],
                },
                machineListStatusByServerId: {},
            }));

            const hook = await renderHook(() => useHasMachineForGettingStartedGuidance(), {
                flushOptions: { cycles: 1, turns: 4 },
            });

            expect(hook.getCurrent()).toBe(false);

            await hook.unmount();
        } finally {
            storage.setState(previousState);
        }
    });
});
