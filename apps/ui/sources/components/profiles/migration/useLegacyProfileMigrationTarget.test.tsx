import { act } from 'react-test-renderer';
import { afterEach, expect, it } from 'vitest';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { useLegacyProfileMigrationTarget } from './useLegacyProfileMigrationTarget';

afterEach(() => { standardCleanup(); clearMachineRequestReachabilityForTest(); });

it('offers only executable migration targets and withdraws a selected target after request failure', async () => {
    const { id: serverId } = await upsertAndActivateServer({ serverUrl: 'https://migration.test', name: 'Migration Home' });
    const machines = [
        createMachineFixture({ id: 'replaced', activeAt: Date.now(), replacedByMachineId: 'first' }),
        createMachineFixture({ id: 'first', activeAt: Date.now() }),
        createMachineFixture({ id: 'second', activeAt: Date.now() }),
    ];
    storage.setState({ machineListByServerId: { [serverId]: machines } });
    const hook = await renderHook(() => useLegacyProfileMigrationTarget());
    expect(hook.getCurrent().targetMachines.map(machine => machine.id)).toEqual(['first', 'second']);
    await act(async () => hook.getCurrent().setPreferredMachineId('second'));
    expect(hook.getCurrent().machineId).toBe('second');
    await act(async () => recordMachineRequestFailed({ serverId, machineId: 'second' }));
    expect(hook.getCurrent().machineId).toBe('first');
    expect(hook.getCurrent().targetMachines.map(machine => machine.id)).toEqual(['first']);
});
