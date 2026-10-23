import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useFilePageShareContext } from './useFilePageShareContext';

afterEach(standardCleanup);

it('keeps File sharing idle for runtime arrivals while following the actual home directory', async () => {
    const before = storage.getState();
    const serverId = getActiveServerSnapshot().serverId;
    let machine = createMachineFixture();
    let renders = 0;
    try {
        storage.getState().applyMachines([machine], true, { sourceServerId: serverId });
        const hook = await renderHook(() => {
            renders++;
            return useFilePageShareContext({ scope: { serverId, machineId: machine.id, rootPath: '/repo' },
                accountScope: null, filePath: 'scale.ts' });
        });
        try {
            expect(hook.getCurrent().homeDir).toBe(machine.metadata!.homeDir);
            const mounted = renders;
            for (let arrival = 1; arrival <= 20; arrival++) {
                machine = { ...machine, seq: machine.seq + 1, daemonStateVersion: arrival,
                    daemonState: { contributionRegistryProjectionRevision: arrival } };
                await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            }
            expect(renders - mounted).toBe(0);
            machine = { ...machine, seq: machine.seq + 1, metadataVersion: machine.metadataVersion + 1,
                metadata: { ...machine.metadata!, homeDir: '/new-home' } };
            await act(async () => storage.getState().applyMachines([machine], false, { sourceServerId: serverId }));
            expect(hook.getCurrent().homeDir).toBe('/new-home');
            expect(renders - mounted).toBe(1);
        } finally { await hook.unmount(); }
    } finally { storage.setState(before); }
});
