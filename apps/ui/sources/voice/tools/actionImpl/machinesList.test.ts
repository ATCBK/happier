import { afterEach, expect, it } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { listMachinesForVoiceTool } from './machinesList';

afterEach(clearMachineRequestReachabilityForTest);

it('provides decoded platform facts to Action input consumers without guessing an absent architecture', async () => {
    const metadata = createMachineFixture().metadata;
    if (!metadata) throw new Error('Expected canonical Machine metadata fixture');
    const known = createMachineFixture({ id: 'known', metadata: { ...metadata, host: 'known.local', platform: 'linux', arch: 'x64' } });
    const unknown = createMachineFixture({ id: 'unknown', metadata: { ...metadata, host: 'unknown.local', platform: 'win32', arch: undefined } });
    storage.setState({ machineListByServerId: { 'facts-home': [known, unknown] }, machineListStatusByServerId: { 'facts-home': 'idle' } });
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId: 'facts-home' })).toMatchObject({ items: [
        { machineId: known.id, platform: 'linux', arch: 'x64' },
        { machineId: unknown.id, platform: 'win32', arch: null },
    ] });
});

it('presents input machines as unavailable after request failure while retaining the inventory', async () => {
    const machine = createMachineFixture({ id: 'voice-machine', activeAt: Date.now() });
    storage.setState({ machineListByServerId: { 'voice-home': [machine] }, machineListStatusByServerId: { 'voice-home': 'idle' } });
    recordMachineRequestFailed({ serverId: 'voice-home', machineId: machine.id });
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId: 'voice-home' })).toMatchObject({
        items: [{ machineId: machine.id, presence: 'offline' }],
    });
});
