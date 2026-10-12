import { afterEach, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { listMachinesForVoiceTool } from './machinesList';

afterEach(clearMachineRequestReachabilityForTest);

it('presents input machines as unavailable after request failure while retaining the inventory', async () => {
    const machine = createMachineFixture({ id: 'voice-machine', activeAt: Date.now() });
    storage.setState({ machineListByServerId: { 'voice-home': [machine] }, machineListStatusByServerId: { 'voice-home': 'idle' } });
    recordMachineRequestFailed({ serverId: 'voice-home', machineId: machine.id });
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId: 'voice-home' })).toMatchObject({
        items: [{ machineId: machine.id, presence: 'offline' }],
    });
});
