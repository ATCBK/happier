import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useWorkspaceDetailsMachineName } from './useWorkspaceDetailsMachineName';

afterEach(standardCleanup);

it('does not republish Details chrome for runtime arrivals, but follows a real Machine rename', async () => {
    const before = storage.getState();
    const serverId = getActiveServerSnapshot().serverId;
    let machine = createMachineFixture({ metadataVersion: 1,
        metadata: { host: 'fixture', displayName: 'Fixture', platform: 'linux',
            happyCliVersion: '1', happyHomeDir: '.happy', homeDir: '/home/fixture' } });
    let renders = 0;
    try {
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const hook = await renderHook(() => { renders++; return useWorkspaceDetailsMachineName(machine.id); });
        try {
            expect(hook.getCurrent()).toBe('Fixture');
            const mounted = renders;
            for (let arrival = 1; arrival <= 20; arrival++) {
                machine = { ...machine, seq: machine.seq + 1, daemonStateVersion: arrival,
                    daemonState: { contributionRegistryProjectionRevision: arrival } };
                await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            }
            expect(renders - mounted).toBe(0);
            machine = { ...machine, seq: machine.seq + 1, metadataVersion: 2,
                metadata: { ...machine.metadata!, displayName: 'Renamed fixture' } };
            await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            expect(hook.getCurrent()).toBe('Renamed fixture');
            expect(renders - mounted).toBe(1);
        } finally { await hook.unmount(); }
    } finally { storage.setState(before); }
});
