import { afterEach, describe, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { adoptHomeProfile, removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { resolveFreshMachineAdministrationExecutionTarget } from './useTargetSelection';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';

const initial = storage.getState();
afterEach(() => { clearMachineRequestReachabilityForTest(); storage.setState(initial, true); });

describe('explicit Administration Retry', () => {
    it('resolves an unreachable exact target while rejecting unavailable content and retired or stale identity', async () => {
        const url = 'https://administration-retry.test';
        const profile = await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: 'srv_administration_retry',
            canonicalServerUrl: url, revision: 1, endpoints: [{ kind: 'https', url }] }, source: 'manual' });
        const accountScope = { serverId: profile.id, accountId: 'retry-account' };
        const target = { serverIdentityId: 'srv_administration_retry', machineId: 'retry-machine' };
        const machine = createMachineFixture({ id: target.machineId, active: false, activeAt: 0 });
        const options = { accountScope, intent: 'retry' as const };
        const publish = (row = machine, status: 'idle' | 'error' | 'signedOut' = 'idle') => storage.setState({
            machines: {}, machineListByServerId: { [profile.id]: [row] }, machineListStatusByServerId: { [profile.id]: status },
        });
        try {
            publish();
            expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })).toBeNull();
            expect(resolveFreshMachineAdministrationExecutionTarget(target, options)?.machine).toBe(machine);
            const activeMachine = { ...machine, active: true, activeAt: Date.now() };
            publish(activeMachine);
            recordMachineRequestFailed({ ...accountScope, machineId: machine.id });
            expect(resolveFreshMachineAdministrationExecutionTarget(target, { accountScope })).toBeNull();
            expect(resolveFreshMachineAdministrationExecutionTarget(target, options)?.machine).toBe(activeMachine);
            publish({ ...machine, availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
            expect(resolveFreshMachineAdministrationExecutionTarget(target, options)).toBeNull();
            publish({ ...machine, revokedAt: 1 });
            expect(resolveFreshMachineAdministrationExecutionTarget(target, options)).toBeNull();
            publish({ ...machine, replacedByMachineId: 'replacement' });
            expect(resolveFreshMachineAdministrationExecutionTarget(target, options)).toBeNull();
            // A failed list read never proves the row gone; a signed-out Home does.
            publish(machine, 'error');
            expect(resolveFreshMachineAdministrationExecutionTarget(target, options)?.machine).toBe(machine);
            publish(machine, 'signedOut');
            expect(resolveFreshMachineAdministrationExecutionTarget(target, options)).toBeNull();
            publish();
            expect(resolveFreshMachineAdministrationExecutionTarget(target, { ...options,
                accountScope: { ...accountScope, serverId: 'other-home' } })).toBeNull();
            expect(resolveFreshMachineAdministrationExecutionTarget(target, { ...options, accountScope: null })).toBeNull();
        } finally { await removeServerProfile(profile.id); }
    });
});
