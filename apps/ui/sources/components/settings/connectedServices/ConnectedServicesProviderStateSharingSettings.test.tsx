import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen, renderHook, standardCleanup } from '@/dev/testkit';
import { settingsParse } from '@/sync/domains/settings/settings';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const confirm = vi.hoisted(() => vi.fn<(...args: Parameters<typeof import('@/modal').Modal.confirm>) => Promise<boolean>>());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm } }).module;
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('socket.io-client', async importOriginal => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();

const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useSetting } = await import('@/sync/store/hooks');
const { getAgentCore } = await import('@/agents/catalog/catalog');
const { ConnectedServicesProviderStateSharingDisclosure } = await import('./ConnectedServicesProviderStateSharingSettings');
const { ProviderStateSharingRows } = await import('./ProviderStateSharingRow');
const originalState = storage.getState();
let account: Awaited<ReturnType<typeof createSecretSettingsTestHarness>>;

function SharingControls({ perAgent }: Readonly<{ perAgent: boolean }>) {
    const settings = useSetting('connectedServicesProviderStateSharingSettingsV1');
    return perAgent
        ? <ProviderStateSharingRows agentId="codex" agentTitle="Codex"
            capability={getAgentCore('codex')?.connectedServices?.providerStateSharing} settings={settings} />
        : <ConnectedServicesProviderStateSharingDisclosure settings={settings} agentIds={['codex']} />;
}
async function startSharing(perAgent: boolean) {
    const screen = await renderScreen(<SharingControls perAgent={perAgent} />);
    if (!perAgent) await screen.pressByTestIdAsync('connected-services-provider-state-sharing-toggle');
    const id = perAgent ? 'connected-services-provider-state-sharing-agent-codex-state'
        : 'connected-services-provider-state-sharing-state-default';
    let pending!: Promise<void>;
    await act(async () => { pending = screen.tree.root.findAllByProps({ testID: id })[0]!.props.rightElement.props.onValueChange(true); });
    return { screen, pending };
}

describe('provider state sharing through configurable Account Action approval', () => {
    beforeEach(async () => {
        confirm.mockReset();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.confirm).mockImplementation(confirm);
        account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        }, connectedServicesProviderStateSharingSettingsV1: { v: 1,
            defaults: { configMode: 'linked', stateMode: 'isolated' }, byAgentId: {}, acknowledgedRisksByAgentId: {},
        } }) });
        // Credential-scope readiness is asynchronous; mounted controls use the
        // exact admitted Home rather than the old debounce-only settings stub.
        const { useSettingActionWriter } = await import('@/components/settings/catalog/useSettingActionWriter');
        const readiness = await renderHook(() => useSettingActionWriter());
        await vi.waitFor(() => expect(readiness.getCurrent().isCurrent()).toBe(true));
    });
    afterEach(async () => { standardCleanup(); await account?.dispose(); storage.setState(originalState, true); });

    it('routes the Permissions page Agent default through the same configurable Action', async () => {
        const { PermissionsSettingsView } = await import('../session/PermissionsSettingsView');
        const target = 'agent:happier.agent.codex/codex';
        await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        })); });
        const screen = await renderScreen(<PermissionsSettingsView />);
        const picker = () => screen.tree.root.findAll(node => typeof node.props.onSelect === 'function'
            && node.props.itemTrigger?.itemProps?.testID === 'settings-permissions-default-codex')[0]!;
        await act(async () => { picker().props.onSelect('default'); });
        expect(storage.getState().settings.sessionDefaultPermissionModeByTargetKey[target]).toBeUndefined();
        expect(account.settingsWrites).toEqual([]);
        await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        })); });
        await act(async () => { picker().props.onSelect('default'); });
        await vi.waitFor(() => expect(account.persistedSettings.sessionDefaultPermissionModeByTargetKey[target]).toBe('default'));
    });

    it.each([false, true])('rebases sharing without losing concurrent preferences (perAgent=%s)', async perAgent => {
        confirm.mockResolvedValue(false);
        const current = account.persistedSettings;
        const sharing = { ...current.connectedServicesProviderStateSharingSettingsV1,
            defaults: { configMode: 'copied' as const, stateMode: 'isolated' as const },
            byAgentId: { claude: { configMode: 'isolated' as const }, codex: { configMode: 'copied' as const } },
            acknowledgedRisksByAgentId: { claude: { sharedStatePrivacy: true as const } },
        };
        const request = account.request.getMockImplementation()!;
        let raced = false;
        // The HTTP CAS boundary races after the Action has prepared its intent.
        account.request.mockImplementation(async (input, init) => {
            if (!raced && new URL(String(input)).pathname === '/v2/account/settings' && init?.method === 'POST') {
                raced = true;
                account.replaceSettings({ ...current, connectedServicesProviderStateSharingSettingsV1: sharing }, { version: 2, publish: false });
            }
            return await request(input, init);
        });
        const { pending } = await startSharing(perAgent);
        await act(async () => { await pending; });
        expect(confirm).not.toHaveBeenCalled();
        const actual = account.persistedSettings.connectedServicesProviderStateSharingSettingsV1;
        expect(actual.defaults).toEqual({ ...sharing.defaults, stateMode: perAgent ? 'isolated' : 'shared' });
        expect(actual.byAgentId).toEqual({ ...sharing.byAgentId, codex: { configMode: 'copied', ...(perAgent ? { stateMode: 'shared' } : {}) } });
        const expectedAcknowledgements = { ...sharing.acknowledgedRisksByAgentId, codex: { sharedStatePrivacy: true } };
        if (perAgent) expect(actual.acknowledgedRisksByAgentId).toEqual(expectedAcknowledgements);
        else expect(actual.acknowledgedRisksByAgentId).toMatchObject(expectedAcknowledgements);
        expect(raced).toBe(true);
    });
    it.each([false, true])('keeps Account settings unchanged when its Action is disabled (perAgent=%s)', async perAgent => {
        confirm.mockResolvedValue(false);
        await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        })); });
        const before = account.persistedSettings.connectedServicesProviderStateSharingSettingsV1;
        const { pending } = await startSharing(perAgent);
        await act(async () => { await pending; });
        expect(confirm).not.toHaveBeenCalled();
        expect(account.persistedSettings.connectedServicesProviderStateSharingSettingsV1).toEqual(before);
        expect(account.settingsWrites).toEqual([]);
    });
});
