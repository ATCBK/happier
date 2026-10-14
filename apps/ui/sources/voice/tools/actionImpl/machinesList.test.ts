import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } from '@/sync/domains/machines/reachability/machineReachability';
import { listMachinesForVoiceTool } from './machinesList';
import { createVoiceSettingsAccountTestHarness } from '@/voice/settings/panels/voiceSettingsAccountTestHarness';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
let account: Awaited<ReturnType<typeof createVoiceSettingsAccountTestHarness>>;
beforeEach(async () => {
    account = await createVoiceSettingsAccountTestHarness(settingsDefaults);
    onTestFinished(account.dispose);
});

afterEach(clearMachineRequestReachabilityForTest);

it('provides decoded platform facts to Action input consumers without guessing an absent architecture', async () => {
    const metadata = createMachineFixture().metadata;
    if (!metadata) throw new Error('Expected canonical Machine metadata fixture');
    const known = createMachineFixture({ id: 'known', metadata: { ...metadata, host: 'known.local', platform: 'linux', arch: 'x64' } });
    const unknown = createMachineFixture({ id: 'unknown', metadata: { ...metadata, host: 'unknown.local', platform: 'win32', arch: undefined } });
    const { serverId } = account.scope;
    storage.setState({ machineListByServerId: { [serverId]: [known, unknown] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId })).toMatchObject({ items: [
        { machineId: known.id, platform: 'linux', arch: 'x64' },
        { machineId: unknown.id, platform: 'win32', arch: null },
    ] });
});

it('presents input machines as unavailable after request failure while retaining the inventory', async () => {
    const machine = createMachineFixture({ id: 'voice-machine', activeAt: Date.now() });
    const { serverId } = account.scope;
    storage.setState({ machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId })).toMatchObject({ items: [{ machineId: machine.id, presence: 'online' }] });
    recordMachineRequestFailed({ ...account.scope, machineId: machine.id });
    expect(await listMachinesForVoiceTool({ purpose: 'input', serverId })).toMatchObject({
        items: [{ machineId: machine.id, presence: 'offline' }],
    });
});
