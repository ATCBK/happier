import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSecretSettingsTestHarness } from '@/components/settings/secrets/secretSettingsTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { PROMPTS_CONTEXT_SETTINGS } from '@/components/settings/prompts/context/promptsContextSettings';
import { useSettingActionWriter } from './useSettingActionWriter';
import { useMachineSummarySetting } from '@/components/machines/summary/useMachineSummarySetting';
import { useMachinesIndexView } from '@/components/settings/machines/machinesIndexSettings';
import { useMachineStorageViewSetting } from '@/components/machines/storage/useMachineStorageViewSetting';
import { createMachineFixture, pressTestInstanceAsync } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { useApplySettings } from '@/sync/store/settingsWriters';
import { useSettingMutable } from '@/sync/store/hooks';

const routerPush = vi.hoisted(() => vi.fn());

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: '/settings/machines', router: { push: routerPush },
}).module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const originalState = storage.getState();
afterEach(() => { standardCleanup(); storage.setState(originalState, true); });

describe('declared setting Action writer', () => {
    it('admits Profiles and other direct Account preferences at the shared settings ingress', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            useProfiles: false, useMachinePickerSearch: false, analyticsOptOut: false,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        let profile: ReturnType<typeof useSettingMutable<'useProfiles'>> | undefined;
        let apply: ReturnType<typeof useApplySettings> | undefined;
        function Probe() { profile = useSettingMutable('useProfiles'); apply = useApplySettings(); return null; }
        try {
            await renderScreen(<Probe />);
            await act(async () => {
                profile![1](true);
                await apply!({ useMachinePickerSearch: true, analyticsOptOut: true });
            });
            expect(storage.getState().settings).toMatchObject({ useProfiles: false, useMachinePickerSearch: false, analyticsOptOut: false });
            expect(account.settingsWrites).toEqual([]);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings,
                actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            })); });
            const retained = profile![1];
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, useProfiles: true })); });
            await act(async () => { retained(current => !current); });
            await vi.waitFor(() => expect(account.persistedSettings.useProfiles).toBe(false));
            await act(async () => { await apply!({ useMachinePickerSearch: true, analyticsOptOut: true, sessionTmuxTmpDir: null }); });
            await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({ useMachinePickerSearch: true, analyticsOptOut: true, sessionTmuxTmpDir: null }));
            const writes = account.settingsWrites.length;
            await act(async () => { profile![1](() => null); });
            expect(account.settingsWrites).toHaveLength(writes);
            await act(async () => {
                // The Action consumer must reject malformed runtime values, rather than storage coercing them.
                // @ts-expect-error Deliberate runtime boundary input with the wrong scalar type.
                await apply!({ useProfiles: 'true' });
            });
            expect(account.persistedSettings.useProfiles).toBe(false);
            expect(account.settingsWrites).toHaveLength(writes);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('preserves JSON values, equivalent aliases and incumbent sparse writes without reviving a retired ingress', async () => {
        const features = createRootLayoutFeaturesResponse();
        expect(tryWriteServerEnabledBitInPlace(features, 'connectedServices.quotas', true)).toBe(true);
        const account = await createSecretSettingsTestHarness({ features, settings: settingsParse({
            useProfiles: false,
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
        }) });
        let apply: ReturnType<typeof useApplySettings> | undefined;
        function Probe() { apply = useApplySettings(); return null; }
        try {
            const screen = await renderScreen(<Probe />);
            await act(async () => { await apply!({ useProfiles: true, sessionListSectionModeV1: 'activity',
                usageCoachPreferencesV1: settingsParse({ usageCoachPreferencesV1: { modelSuggestion: 'off' } }).usageCoachPreferencesV1,
                sessionUsageGaugeLabels: true }); });
            await vi.waitFor(() => expect(account.persistedSettings).toMatchObject({
                useProfiles: true, sessionListSectionModeV1: 'activity', usageCoachPreferencesV1: { modelSuggestion: 'off' }, sessionUsageGaugeLabels: true,
            }));
            const retained = apply!;
            const writes = account.settingsWrites.length;
            await act(async () => { screen.tree.update(<></>); });
            await act(async () => { await retained({ useProfiles: false }); });
            expect(account.persistedSettings.useProfiles).toBe(true);
            expect(account.settingsWrites).toHaveLength(writes);
            const updater = vi.fn(() => ({ useProfiles: false }));
            await act(async () => { storage.setState({ settingsScope: { serverId: account.scope.serverId, accountId: 'another-account' } }); });
            await act(async () => { await retained(updater); });
            expect(updater).not.toHaveBeenCalled();
            expect(account.settingsWrites).toHaveLength(writes);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('routes the mounted Machine connection choice through admitted keyed Settings Actions in the exact Home', async () => {
        const preferences = { v: 1, flows: { machine_rpc: { direct: 'disabled' } },
            byMachineId: { other: { flows: { machine_rpc: { direct: 'enabled' } } } } } as const;
        const features = createRootLayoutFeaturesResponse();
        for (const featureId of ['machines.rpc.directPeer', 'machines.transfer.directPeer', 'machines.tunnel.directPeer', 'machines.liveStream.directPeer'] as const) {
            expect(tryWriteServerEnabledBitInPlace(features, featureId, true)).toBe(true);
        }
        const account = await createSecretSettingsTestHarness({ features, settings: settingsParse({
            peerMediationPreferencesV1: preferences,
            actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } },
        }) });
        try {
            const { MachineDirectConnectionSection } = await import('@/components/settings/connections/DirectConnectionSettings');
            const screen = await renderScreen(<MachineDirectConnectionSection serverId={account.scope.serverId} machineId="machine-a" machineName="Laptop" />);
            const choose = async (choice: 'direct' | 'relay' | 'default') => {
                await act(async () => { await pressTestInstanceAsync(screen.findByTestId(`machine-direct-connection:${choice}`)!); });
            };
            await choose('direct');
            expect(account.persistedSettings.peerMediationPreferencesV1).toEqual(preferences);
            await act(async () => { account.replaceSettings(settingsParse({ ...account.persistedSettings, actionsSettingsV1: {
                v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            for (const choice of ['direct', 'relay', 'default'] as const) {
                await choose(choice);
                await vi.waitFor(() => expect(account.persistedSettings.peerMediationPreferencesV1.byMachineId['machine-a']?.flows.machine_rpc?.direct)
                    .toBe(choice === 'default' ? undefined : choice === 'direct' ? 'enabled' : 'disabled'));
                expect(account.persistedSettings.peerMediationPreferencesV1.flows).toEqual(preferences.flows);
                expect(account.persistedSettings.peerMediationPreferencesV1.byMachineId.other).toEqual(preferences.byMachineId.other);
            }
            await act(async () => { screen.tree.update(<MachineDirectConnectionSection serverId="another-home" machineId="machine-a" machineName="Laptop" />); });
            const before = account.settingsWrites.length;
            await choose('direct');
            expect(account.settingsWrites).toHaveLength(before);
            expect(account.persistedSettings.peerMediationPreferencesV1.byMachineId['machine-a']).toBeUndefined();
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('writes keyed Agent preferences through the public Account Action without replacing another target', async () => {
        const other = 'agent:happier.agent.claude/claude';
        const target = 'agent:happier.agent.codex/codex';
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] } },
            backendEnabledByTargetKey: { [other]: false },
        }) });
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { write = useSettingActionWriter(); return null; }
        try {
            await renderScreen(<Probe />);
            await act(async () => {
                expect(await write!({ anchor: 'agents.enabled' }, { agentTargetKey: target, value: true })).toMatchObject({ ok: true });
                expect(await write!({ anchor: 'agents.defaultPermission' }, { agentTargetKey: target, value: 'default' })).toMatchObject({ ok: true });
                expect(await write!({ anchor: 'agents.executableSource' }, { agentTargetKey: target, value: 'managed-first' })).toMatchObject({ ok: true });
            });
            expect(account.persistedSettings.backendEnabledByTargetKey).toEqual({ [other]: false, [target]: true });
            expect(account.persistedSettings.sessionDefaultPermissionModeByTargetKey[target]).toBe('default');
            expect(account.persistedSettings.backendCliSourcePreferenceByTargetKey[target]).toBe('managed-first');
        } finally { await account.dispose(); }
    });
    it('switches All machines to Grid through admitted Settings Actions and opens the same machine page', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        } }) });
        const serverId = account.scope.serverId;
        const machine = createMachineFixture({ id: 'machine-a1', active: false, activeAt: 0,
            metadata: { ...createMachineFixture().metadata!, displayName: 'Machine A1', host: 'a.local', platform: 'darwin' } });
        try {
            routerPush.mockClear();
            storage.setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] },
                machineListStatusByServerId: { [serverId]: 'idle' } });
            storage.getState().applyLocalSettings({ machinesIndexViewV1: 'list' });
            const { AllMachinesIndex } = await import('@/components/machines/index/AllMachinesIndex');
            const screen = await renderScreen(<AllMachinesIndex />);
            const tree = screen.tree;
            const viewSwitch = () => tree.findAll(node => node.props?.testIDPrefix === 'machines.index.view'
                && typeof node.props?.onSelectTab === 'function')[0]!;
            await act(async () => { viewSwitch().props.onSelectTab('grid'); });
            await vi.waitFor(() => expect(tree.findAll(node => node.props?.testID === 'machines.index.collection'
                && node.props?.presentation === 'grid').length).toBeGreaterThan(0));
            // React Native's layout callback is the renderer boundary; the Collection model stays real.
            await act(async () => {
                for (const node of tree.findAll(candidate => typeof candidate.props?.onLayout === 'function')) {
                    node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 1200, height: 900 } } });
                }
            });
            expect(tree.findAll(node => node.props?.testID === `machines.index.card.machine:${serverId}:${machine.id}`).length).toBeGreaterThan(0);
            const card = tree.findAll(node => node.props?.testID === `machines.index.row.machine:${serverId}:${machine.id}`
                && typeof node.props?.onPress === 'function')[0]!;
            await act(async () => { await pressTestInstanceAsync(card); });
            expect(routerPush).toHaveBeenCalledWith(`/settings/machines/${machine.id}?serverId=${encodeURIComponent(serverId)}`);
            expect(storage.getState().localSettings.machinesIndexViewV1).toBe('grid');
            await act(async () => { viewSwitch().props.onSelectTab('list'); });
            await vi.waitFor(() => expect(storage.getState().localSettings.machinesIndexViewV1).toBe('list'));
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('keeps a phone in List while admitting desktop shape and sort through the same local Action owner', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }) });
        const key = `${account.scope.serverId}\u0000machine`;
        let desktop: ReturnType<typeof useMachineStorageViewSetting> | undefined;
        let phone: ReturnType<typeof useMachineStorageViewSetting> | undefined;
        function Probe() {
            desktop = useMachineStorageViewSetting(account.scope.serverId, 'machine', false);
            phone = useMachineStorageViewSetting(account.scope.serverId, 'machine', true);
            return null;
        }
        try {
            storage.getState().applyLocalSettings({ machineStorageViewV1: { [key]: { shape: 'rings', sort: { by: 'size', direction: 'desc' } } } });
            await renderScreen(<Probe />);
            await act(async () => { desktop!.remember({ shape: 'map' }); });
            expect(desktop!.shape).toBe('rings');
            expect(phone!.shape).toBe('list');
            await act(async () => { account.replaceSettings(settingsParse({ actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            await act(async () => { desktop!.remember({ shape: 'map' }); phone!.remember({ sort: { by: 'name', direction: 'asc' } }); });
            await vi.waitFor(() => expect(storage.getState().localSettings.machineStorageViewV1[key])
                .toEqual({ shape: 'map', sort: { by: 'name', direction: 'asc' } }));
            expect(desktop!.shape).toBe('map');
            expect(phone!.shape).toBe('list');
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('retains the keyed Storage operand at the mounted Settings Action ingress', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, approvalWaivedSurfaces: { 'settings.set': ['ui'] },
        } }) });
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { write = useSettingActionWriter(); return null; }
        const key = `${account.scope.serverId}\u0000machine`;
        try {
            storage.getState().applyLocalSettings({ machineStorageViewV1: {} });
            await renderScreen(<Probe />);
            const setting = { anchor: 'machines.storage.view', key };
            let result: Awaited<ReturnType<NonNullable<typeof write>>> | undefined;
            await act(async () => { result = await write!(setting, { shape: 'rings' }); });
            expect(result).toMatchObject({ ok: true });
            expect(storage.getState().localSettings.machineStorageViewV1[key]).toEqual({ shape: 'rings', sort: { by: 'size', direction: 'desc' } });
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('applies Summary and All machines choices only when their UI Settings Action is admitted', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } },
        } }) });
        let controls: Readonly<{ summary: ReturnType<typeof useMachineSummarySetting>; index: ReturnType<typeof useMachinesIndexView> }> | undefined;
        function Probe() { controls = { summary: useMachineSummarySetting(), index: useMachinesIndexView() }; return null; }
        try {
            storage.getState().applyLocalSettings({ uiMachineSummaryStyle: 'sparklines', uiMachineSummaryMetrics: ['cpu'], machinesIndexViewV1: 'list' });
            await renderScreen(<Probe />);
            await act(async () => {
                controls!.summary.setStyle('rings');
                controls!.summary.toggleMetric('cpu');
                controls!.index[1]('grid');
            });
            expect(storage.getState().localSettings).toMatchObject({
                uiMachineSummaryStyle: 'sparklines', uiMachineSummaryMetrics: ['cpu'], machinesIndexViewV1: 'list',
            });
            await act(async () => { account.replaceSettings(settingsParse({ actionsSettingsV1: { v: 1,
                approvalWaivedSurfaces: { 'settings.set': ['ui'] },
            } })); });
            await act(async () => {
                controls!.summary.setStyle('rings');
                controls!.summary.toggleMetric('cpu');
                controls!.index[1]('grid');
            });
            await vi.waitFor(() => expect(storage.getState().localSettings).toMatchObject({
                uiMachineSummaryStyle: 'rings', uiMachineSummaryMetrics: [], machinesIndexViewV1: 'grid',
            }));
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('propagates an admitted Account setting result from the real Action owner', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { write = useSettingActionWriter(); return null; }
        try {
            await renderScreen(<Probe />);
            if (!write) throw new Error('Writer missing');
            let result: Awaited<ReturnType<typeof write>> | undefined;
            await act(async () => { result = await write!(PROMPTS_CONTEXT_SETTINGS.settings.memoryUseInNewSessions, true); });
            expect(result).toMatchObject({ ok: true });
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(true);
        } finally { standardCleanup(); await account.dispose(); }
    });
    it('refuses the same Account setting when the viewed Home is not its captured owner', async () => {
        const account = await createSecretSettingsTestHarness({ settings: settingsParse({}) });
        let write: ReturnType<typeof useSettingActionWriter> | undefined;
        function Probe() { write = useSettingActionWriter({ serverId: 'another-home' }); return null; }
        try {
            await renderScreen(<Probe />);
            if (!write) throw new Error('Writer missing');
            let result: Awaited<ReturnType<typeof write>> | undefined;
            await act(async () => { result = await write!(PROMPTS_CONTEXT_SETTINGS.settings.memoryUseInNewSessions, true); });
            expect(result).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
            expect(account.persistedSettings.memoryUseInNewSessions).toBe(false);
            expect(account.settingsWrites).toEqual([]);
        } finally { standardCleanup(); await account.dispose(); }
    });
});
