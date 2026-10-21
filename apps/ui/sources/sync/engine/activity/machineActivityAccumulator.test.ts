import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { createMachineFixture } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createMachinesDomain, type MachinesDomain } from '@/sync/store/domains/machines';
import type { StorageState } from '@/sync/store/types';
import { buildMachineFromMachineActivityEphemeralUpdate } from '../machines/syncMachines';

import { MachineActivityAccumulator, type MachineActivityUpdate } from "./machineActivityAccumulator.js";

describe('MachineActivityAccumulator', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it.each([true, false])('retains newer pending presence through the real store when delayed active=%s arrives', async active => {
        type TestState = MachinesDomain & Pick<StorageState,
            'sessions' | 'sessionListRowsByServerId' | 'ordinarySessionListMembershipByServerId'
            | 'sessionListIndexByServerId' | 'settings'
        > & { profile: { id: string } };
        const store = createStore<TestState>()((set, get) => ({
            sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {},
            sessionListIndexByServerId: {}, settings: settingsDefaults, profile: { id: 'presence-account' },
            ...createMachinesDomain<TestState>({ set, get }),
        }));
        const sourceServerId = getActiveServerSnapshot().serverId;
        const now = Date.now();
        const machine = createMachineFixture({ id: 'ordered-presence', active: true, activeAt: now - 3_000 });
        store.getState().applyMachines([machine], true, { sourceServerId });
        const accumulator = new MachineActivityAccumulator((updates, options) => {
            store.getState().applyMachines([...updates.values()].map(updateData => buildMachineFromMachineActivityEphemeralUpdate({
                machine: store.getState().machines[updateData.id]!, updateData,
            })), false, options);
        });
        try {
            accumulator.addUpdate({ id: machine.id, active: true, activeAt: now - 3_000 }, { sourceServerId });
            accumulator.addUpdate({ id: machine.id, active: true, activeAt: now - 1_000 }, { sourceServerId });
            accumulator.addUpdate({ id: machine.id, active, activeAt: now - 2_000 }, { sourceServerId });
            await vi.advanceTimersByTimeAsync(300);
            expect(store.getState().machines[machine.id]).toMatchObject({ active: true, activeAt: now - 1_000 });
            expect(store.getState().machinePresenceByServerId[sourceServerId]?.[machine.id])
                .toMatchObject({ active: true, activeAt: now - 1_000 });

            accumulator.addUpdate({ id: machine.id, active: false, activeAt: now }, { sourceServerId });
            expect(store.getState().machines[machine.id]).toMatchObject({ active: false, activeAt: now });
            accumulator.addUpdate({ id: machine.id, active: true, activeAt: now + 1 }, { sourceServerId });
            expect(store.getState().machines[machine.id]).toMatchObject({ active: true, activeAt: now + 1 });
        } finally {
            accumulator.reset();
        }
    });

    it('drops pending updates whose guard becomes stale before debounce flush', async () => {
        let isCurrentScope = true;
        const flushHandler = vi.fn();
        const accumulator = new MachineActivityAccumulator(flushHandler, 300);
        const update1: MachineActivityUpdate = {
            id: 'machine1',
            active: true,
            activeAt: 1_000,
        };
        const update2: MachineActivityUpdate = {
            id: 'machine1',
            active: true,
            activeAt: 1_100,
        };

        accumulator.addUpdate(update1, { shouldContinue: () => isCurrentScope });
        accumulator.addUpdate(update2, { shouldContinue: () => isCurrentScope });

        expect(flushHandler).toHaveBeenCalledTimes(1);

        isCurrentScope = false;
        await vi.runAllTimersAsync();

        expect(flushHandler).toHaveBeenCalledTimes(1);
    });

    it.each(['retired scope', 'different Home'])('does not retain a newer pending fact from a %s', async boundary => {
        let pendingIsCurrent = true;
        const flushHandler = vi.fn();
        const accumulator = new MachineActivityAccumulator(flushHandler);
        accumulator.addUpdate({ id: 'machine1', active: true, activeAt: 1_000 }, { sourceServerId: 'server-a' });
        accumulator.addUpdate({ id: 'machine1', active: true, activeAt: 3_000 }, {
            sourceServerId: 'server-a', shouldContinue: () => pendingIsCurrent,
        });
        if (boundary === 'retired scope') pendingIsCurrent = false;
        const sourceServerId = boundary === 'different Home' ? 'server-b' : 'server-a';
        accumulator.addUpdate({ id: 'machine1', active: true, activeAt: 2_000 }, { sourceServerId });
        await vi.advanceTimersByTimeAsync(300);
        expect(flushHandler).toHaveBeenLastCalledWith(
            new Map([['machine1', { id: 'machine1', active: true, activeAt: 2_000 }]]),
            { sourceServerId },
        );
        accumulator.reset();
    });

    it('preserves source server ids when debounced updates flush', async () => {
        const flushHandler = vi.fn();
        const accumulator = new MachineActivityAccumulator(flushHandler, 300);

        accumulator.addUpdate({ id: 'machine1', active: true, activeAt: 1_000 }, { sourceServerId: 'server-a' });
        accumulator.addUpdate({ id: 'machine1', active: true, activeAt: 1_100 }, { sourceServerId: 'server-a' });

        await vi.runAllTimersAsync();

        expect(flushHandler).toHaveBeenLastCalledWith(
            new Map([['machine1', { id: 'machine1', active: true, activeAt: 1_100 }]]),
            { sourceServerId: 'server-a' },
        );
    });
});
