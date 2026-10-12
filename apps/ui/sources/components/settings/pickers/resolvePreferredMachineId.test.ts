import { expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { listPreferredMachineIds, resolvePreferredLaunchMachineId } from './resolvePreferredMachineId';

it('ranks only selectable machines online while retaining remembered offline launch intent', () => {
    const now = Date.now();
    const machines = [
        createMachineFixture({ id: 'offline', active: false, activeAt: 1 }),
        createMachineFixture({ id: 'replaced', activeAt: now, replacedByMachineId: 'ready' }),
        createMachineFixture({ id: 'locked', activeAt: now, availability: { kind: 'locked', reason: 'encryption_material_unavailable' } }),
        createMachineFixture({ id: 'ready', activeAt: now }),
    ];
    const input = { machines, recentMachinePaths: [{ machineId: 'offline' }], scope: { serverId: 'preference-home', accountId: 'preference-account' } };
    expect(listPreferredMachineIds({ ...input, onlineOnly: true })).toEqual(['ready']);
    expect(resolvePreferredLaunchMachineId(input)).toBe('ready');
    expect(resolvePreferredLaunchMachineId({ ...input, machines: [machines[0]!] })).toBe('offline');
});
