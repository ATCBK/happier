import { beforeEach, describe, expect, it } from 'vitest';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { resolveMachinePickerPresence } from './resolveMachinePickerPresence';

describe('resolveMachinePickerPresence', () => {
    beforeEach(() => clearMachineRequestReachabilityForTest());

    it('projects exact Account reachability without admitting another Account failure', () => {
        const scope = { serverId: 'picker-home', accountId: 'picker-account' };
        const nowMs = 1_900_000_000_000;
        const machine = { id: 'picker-machine', active: true, activeAt: nowMs };
        recordMachineRequestFailed({ ...scope, machineId: machine.id, observedAtMs: nowMs });
        expect(resolveMachinePickerPresence(machine, nowMs, scope)).toEqual({ status: 'offline', selectable: false, reason: 'home_unreachable' });
        expect(resolveMachinePickerPresence({ ...machine, active: false, activeAt: 0 }, nowMs, { ...scope, accountId: 'other-account' }))
            .toEqual({ status: 'offline', selectable: false, reason: 'offline' });
        expect(resolveMachinePickerPresence(machine, nowMs, { ...scope, accountId: 'other-account' }))
            .toEqual({ status: 'online', selectable: true });
    });
});
