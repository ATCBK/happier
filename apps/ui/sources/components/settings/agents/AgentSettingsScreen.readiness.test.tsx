import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';

const navigation = vi.hoisted(() => ({ params: {} as Record<string, string>, push: vi.fn() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: () => navigation.params, router: { push: navigation.push },
}).module);
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const daemon = createProviderSettingsHarness();
installProviderSettingsRpcBoundary(daemon);
const account = createProviderSettingsAccountHarness();
const { AgentSettingsScreen } = await import('./AgentSettingsScreen');
const { useAgentsAdministrationTargetSelection } = await import('./collection/useAgentAdministrationCatalog');
const { useOpenSessionReadinessRepair } = await import('@/components/sessions/readiness/SessionReadinessChecklist');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');

afterEach(async () => { standardCleanup(); navigation.params = {}; navigation.push.mockClear(); await account.reset(); });

it('opens native repair on the Bot exact Home and Machine instead of the saved settings Machine', async () => {
    const { serverId, accountId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'settings-machine', activeAt: Date.now() }),
        createMachineFixture({ id: 'bot-machine', activeAt: Date.now() }),
    ] });
    await account.selectMachine(serverId, 'settings-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    const scope = { serverId, accountId };
    const repair = await renderHook(() => useOpenSessionReadinessRepair(scope));
    repair.getCurrent()({ actionId: 'machines.agents.signIn.start', input: { machineId: 'bot-machine', agentId: 'codex', method: 'native' } });
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/(app)/settings/agents/[agentId]',
        params: { agentId: 'codex', machineId: 'bot-machine', serverIdentityId: 'srv_readiness' } });
});

it('opens the expired operation account reconnect continuation on the exact Home and Machine', async () => {
    const { serverId, accountId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'settings-machine', activeAt: Date.now() }),
        createMachineFixture({ id: 'bot-machine', activeAt: Date.now() }),
    ] });
    const repair = await renderHook(() => useOpenSessionReadinessRepair({ serverId, accountId }));
    repair.getCurrent()({ actionId: 'connectedServices.authentication.beginReconnect', input: {
        machineId: 'bot-machine', account: { service: { pluginId: 'acme.external', localId: 'account' }, accountId: 'work' },
    } });
    expect(navigation.push).toHaveBeenCalledWith({ pathname: '/(app)/settings/connected-services/connect', params: {
        service: 'acme.external/account', accountId: 'work', machineId: 'bot-machine', serverIdentityId: 'srv_readiness', expectedAccountId: accountId,
    } });
});

it('consumes the reconnect route target before its authentication continuation can choose the saved Machine', async () => {
    const { serverId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'settings-machine', activeAt: Date.now() }),
        createMachineFixture({ id: 'bot-machine', activeAt: Date.now() }),
    ] });
    await account.selectMachine(serverId, 'settings-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.connectedAccounts);
    navigation.params = { service: 'happier.agent.codex/openai-codex', accountId: 'work', machineId: 'bot-machine', serverIdentityId: 'srv_readiness' };
    const { ConnectedServiceSetupPage } = await import('@/components/settings/connectedServices/setup/ConnectedServiceSetupPage');
    const screen = await renderScreen(<AppPaneProvider><ConnectedServiceSetupPage /></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.tree.root.findByProps({ chrome: 'page' }).props.targetSelection?.selectedTarget)
        .toEqual({ serverIdentityId: 'srv_readiness', machineId: 'bot-machine' }));
});

it('refuses reconnect continuation after its execution Account changes', async () => {
    await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'bot-machine', activeAt: Date.now() }),
    ] });
    navigation.params = { service: 'happier.agent.codex/openai-codex', accountId: 'work', machineId: 'bot-machine',
        serverIdentityId: 'srv_readiness', expectedAccountId: 'another-account' };
    const { ConnectedServiceSetupPage } = await import('@/components/settings/connectedServices/setup/ConnectedServiceSetupPage');
    const screen = await renderScreen(<AppPaneProvider><ConnectedServiceSetupPage /></AppPaneProvider>);
    expect(screen.tree.root.findAllByProps({ testID: 'connected-account-purpose-unavailable' }).length).toBeGreaterThan(0);
});

it('consumes the exact sign-in route target without requiring an install request', async () => {
    const { serverId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'settings-machine', activeAt: Date.now() }),
        createMachineFixture({ id: 'bot-machine', activeAt: Date.now() }),
    ] });
    await account.selectMachine(serverId, 'settings-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    navigation.params = { agentId: 'codex', machineId: 'bot-machine', serverIdentityId: 'srv_readiness' };
    const selected = await renderHook(() => useAgentsAdministrationTargetSelection());
    await renderScreen(<AppPaneProvider><AgentSettingsScreen /></AppPaneProvider>);
    await vi.waitFor(() => expect(selected.getCurrent().selectedTarget).toEqual({ serverIdentityId: 'srv_readiness', machineId: 'bot-machine' }));
    await act(async () => selected.getCurrent().selectTarget({ serverIdentityId: 'srv_readiness', machineId: 'settings-machine' }));
    expect(selected.getCurrent().selectedTarget?.machineId).toBe('settings-machine');
});

it('keeps an unknown repair Machine unavailable instead of using the saved settings target', async () => {
    const { serverId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'settings-machine', activeAt: Date.now() }),
    ] });
    await account.selectMachine(serverId, 'settings-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    const selected = await renderHook(() => useAgentsAdministrationTargetSelection({ machineId: 'missing-bot', serverIdentityId: 'srv_readiness' }));
    expect(selected.getCurrent().selectedTarget).toEqual({ serverIdentityId: 'srv_readiness', machineId: 'missing-bot' });
    expect(selected.getCurrent().state.kind).toBe('missing');
    expect(selected.getCurrent().resolveExecutionTarget()).toBeNull();
});

it('qualifies equal Machine ids by the repair Home', async () => {
    const { serverId } = await account.restore({ serverIdentityId: 'srv_readiness', machines: [
        createMachineFixture({ id: 'same-machine', activeAt: Date.now() }),
    ] });
    await account.selectMachine(serverId, 'same-machine', MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents);
    const peer = await account.addHome({ name: 'Bot Home', serverUrl: 'https://bot-home.test',
        serverIdentityId: 'srv_bot_home', accountId: 'account-a', active: false });
    await account.publishMachines(peer, [createMachineFixture({ id: 'same-machine', activeAt: Date.now() })]);
    const selected = await renderHook(() => useAgentsAdministrationTargetSelection({ machineId: 'same-machine', serverIdentityId: 'srv_bot_home' }));
    await vi.waitFor(() => expect(selected.getCurrent().selectedTarget).toEqual({ serverIdentityId: 'srv_bot_home', machineId: 'same-machine' }));
    await vi.waitFor(() => expect(selected.getCurrent().resolveExecutionTarget()?.target).toEqual({ serverIdentityId: 'srv_bot_home', machineId: 'same-machine' }));
});
