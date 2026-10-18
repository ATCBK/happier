import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { SessionServerStartSpawnDraftV1Schema, type SessionServerStartSpawnDraftV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import type { CustomModalChromeConfig } from '@/modal';
import { PluginUiJsonObjectV1Schema, type PluginUiSurfaceContextV1 } from '@happier-dev/protocol/plugins/ui';
import type { PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: key => key });
});
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

// Only network/device/native boundaries are replaced. The modal, catalog,
// organization hook, shared controls and strict draft-edit adapter stay real.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { createPluginSurfaceContextFixture } = await import('@/dev/testkit/fixtures/pluginSurfaceContextFixture');
const { storage } = await import('@/sync/domains/state/storage');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
const { resolveServerProfileScopeIdForIdentifier, setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
const { restoreConnectionToActiveServer, disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { SessionServerStartDraftComposerModal } = await import('./SessionServerStartDraftComposerModal');
const { SessionAuthoringControls } = await import('@/components/sessions/authoring/controls/SessionAuthoringControls');
const { PathSelectionList } = await import('./components/PathSelectionList');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');
const { RoundButton } = await import('@/components/ui/buttons/RoundButton');
const { Item } = await import('@/components/ui/lists/Item');
const { Modal } = await import('@/modal');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { createPluginActionInputSelectionHostApiHandler } = await import('@/components/plugins/surfaces/pluginActionInputSelectionHostApi');
const { createPluginSurfaceHostApi } = await import('@/components/plugins/surfaces/createPluginSurfaceHostApi');
const { createCanonicalPluginReactNativeHostApiAdapter } = await import('@/components/plugins/reactNative/hostApi');

function RecipeRequestingPlugin({ api, request }: Readonly<{ api: PluginUiHostApi; request(): void }>) {
    return <RoundButton title="Choose recipe" onPress={request} disabled={!api.version().methods.includes('selectActionInput')} />;
}

afterAll(async () => {
    await disconnectActiveServerConnection();
    await network.dispose();
});
afterEach(async () => {
    standardCleanup();
    clearDaemonMergedProjectionCacheForTests();
    await disconnectActiveServerConnection();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
});

describe('mounted Session server-start recipe composer', () => {
    let serverId: string;
    let serverAlias: string;
    let otherServerId: string;
    let homeSequence = 0;
    beforeEach(async () => {
        network.resetRequests();
        storage.setState(storage.getInitialState(), true);
        const profilesByOrigin = new Map<string, ReturnType<typeof AccountProfileSchema.parse>>();
        network.setHttpResponder(async input => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                features: { sessions: { folders: { enabled: true } } },
            }));
            // This fixture restores the real Sync singleton. Its core bootstrap
            // must settle before a later restoration can acquire Machine data.
            if (url.pathname === '/v2/account/settings') return Response.json(AccountSettingsV2GetResponseSchema.parse({
                content: { t: 'plain', v: { experiments: true, featureToggles: { 'sessions.folders': true } } }, version: 1,
            }));
            const profile = profilesByOrigin.get(url.origin);
            return url.pathname === '/v1/account/profile' && profile ? Response.json(profile) : null;
        });
        const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1, agentsById: {
            'acme.recipe/agent': { id: 'acme.recipe/agent', identity: { pluginId: 'acme.recipe', localId: 'agent' },
                title: 'Recipe Agent', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        } });
        network.setRpcAckResponder(async request => request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE
            ? { ok: true, result: { protocolVersion: 1, projection } }
            : { ok: false, error: 'Not available in fixture', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
        homeSequence += 1;
        const home = await network.addHome(`https://recipe-composer-${homeSequence}.example.test`, 'recipe-account');
        const other = await network.addHome(`https://recipe-other-${homeSequence}.example.test`, 'other-account');
        profilesByOrigin.set(new URL(home.serverUrl).origin, AccountProfileSchema.parse({ id: home.accountId }));
        profilesByOrigin.set(new URL(other.serverUrl).origin, AccountProfileSchema.parse({ id: other.accountId }));
        serverAlias = home.id;
        await setServerProfileIdentityForUrl(home.serverUrl, `srv_recipe_composer_${homeSequence}`);
        serverId = resolveServerProfileScopeIdForIdentifier(serverAlias);
        otherServerId = other.id;
        await upsertAndActivateServer({ serverUrl: home.serverUrl });
        await restoreConnectionToActiveServer({ token: home.token });
        await waitForHomeGovernance(() => {
            expect(storage.getState().machines['machine-1']).toBeDefined();
            expect(storage.getState().accountSettingsSyncStatus.state).toBe('synced');
            expect(storage.getState().profile.id).toBe(home.accountId);
        });
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() })], true, { sourceServerId: serverId });
        storage.getState().upsertSessionOrganizationFolderOptimistic(serverId, {
            folderId: 'intake', folderKey: 'intake', parentFolderId: null, parentFolderKey: null,
            sortKey: null, archivedAt: null, createdAt: 1, updatedAt: 1,
            display: { t: 'plain', v: { name: 'Intake', workspace: {
                t: 'workspaceScope', serverId, machineId: 'machine-1', rootPath: '/repo',
            } } },
            displayState: { status: 'available', value: { name: 'Intake', workspace: {
                t: 'workspaceScope', serverId, machineId: 'machine-1', rootPath: '/repo',
            } } },
        });
        clearDaemonMergedProjectionCacheForTests();
    });

    function recipe(configuration = false): SessionServerStartSpawnDraftV1 {
        return SessionServerStartSpawnDraftV1Schema.parse({
            executionTarget: { serverId, machineId: 'machine-1' }, directory: { kind: 'path', path: '/repo' },
            agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
            title: 'Intake', roleId: 'intake', profileId: 'work', permissionMode: 'read-only',
            allowedTools: ['mcp__intake__*'], unlistedTools: 'deny',
            organizationPlacement: { folderId: 'intake', tagIds: ['mail'] },
            capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['intake'], forceExcludeServerIds: [] } },
            ...(configuration ? { configuration: { mode: { value: null, updatedAtMs: 1 },
                model: { value: null, updatedAtMs: 2 }, permissionIntent: { value: 'read-only', updatedAtMs: 3 },
                options: { reasoning: { value: 'low', updatedAtMs: 4 } },
                providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'native-resume' } } } : {}),
        });
    }
    async function mount(draft: SessionServerStartSpawnDraftV1, target = draft.executionTarget) {
        let chrome: CustomModalChromeConfig | null = null;
        const onResolve = vi.fn();
        const screen = await renderScreen(<SessionServerStartDraftComposerModal
            seed={{ existingDraft: draft }} target={target} onResolve={onResolve} onClose={() => {}}
            setChrome={value => { chrome = value; }} />);
        async function submit() {
            await waitForHomeGovernance(() => {
                expect(chrome?.kind).toBe('card');
                if (chrome?.kind !== 'card') throw new Error('Missing card');
                const footer = chrome.footer as React.ReactElement<{ children: React.ReactNode }>;
                const button = React.Children.toArray(footer.props.children).find(child =>
                    React.isValidElement<{ title: string }>(child) && child.type === RoundButton && child.props.title === 'common.create');
                if (!React.isValidElement<{ disabled: boolean }>(button)) throw new Error('Missing submit');
                expect(button.props.disabled).toBe(false);
            });
            if (chrome?.kind !== 'card') throw new Error('Missing card');
            const footer = await renderScreen(<>{chrome.footer}</>);
            await act(async () => { footer.findAllByType(RoundButton).find(node => node.props.title === 'common.create')!.props.onPress(); });
            await footer.unmount();
            expect(onResolve).toHaveBeenCalledTimes(1);
            return SessionServerStartSpawnDraftV1Schema.parse(onResolve.mock.calls[0]![0]);
        }
        return { screen, submit };
    }

    it.each([
        { name: 'canonical Home', aliasHost: false, aliasRecipe: false },
        { name: 'saved recipe Home alias', aliasHost: false, aliasRecipe: true },
        { name: 'mounted and saved Home aliases', aliasHost: true, aliasRecipe: true },
    ])('composes a mounted external plugin recipe with $name and all authoring controls', async ({ aliasHost, aliasRecipe }) => {
        const draft = recipe();
        const requestedDraft = aliasRecipe
            ? { ...draft, executionTarget: { ...draft.executionTarget, serverId: serverAlias } }
            : draft;
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Missing Home lifetime');
        const requestSurface: PluginUiSurfaceContextV1 = {
            pluginId: 'example.recipe', contributionId: 'settings', surfaceId: 'recipe-settings',
            placement: 'appSurface', platform: 'ios', channel: 'internal', resourceScope: [], diagnostics: [],
        };
        const selector = createPluginActionInputSelectionHostApiHandler({
            host: { machineId: 'machine-1', serverId: aliasHost ? serverAlias : serverId,
                targetPluginId: requestSurface.pluginId, accountLifetime: lifetime },
            isCurrent: lifetime.isCurrent,
        });
        const host = createPluginSurfaceHostApi({ surfaceContext: requestSurface, handlers: { selectActionInput: selector } });
        const surface = createPluginSurfaceContextFixture({ platform: 'ios', target: { kind: 'app' },
            accountEncryptionMode: 'plain', targetedContributions: undefined, mount: { kind: 'destination',
                destination: { pluginId: requestSurface.pluginId, localId: 'settings' }, container: 'appPage' } });
        const request = { hostAction: { action: 'session.spawn_new', projection: 'serverStartDraft' },
            draft: PluginUiJsonObjectV1Schema.parse({ existingDraft: requestedDraft,
                candidates: [{ projectKey: { id: 'project-intake' }, serverId: aliasRecipe ? serverAlias : serverId,
                    machineId: 'machine-1', rootPath: '/repo', reachable: true, worktrees: [] }] }) } as const;
        // Removing the real host registration must refuse before any dialog opens.
        vi.mocked(Modal.show).mockClear();
        const unwiredHost = createPluginSurfaceHostApi({ surfaceContext: requestSurface });
        const unwired = createCanonicalPluginReactNativeHostApiAdapter({ surface, requestSurface,
            requestIdPrefix: 'unwired-recipe', handleRequest: unwiredHost.handleRequest, installedMethods: unwiredHost.installedMethods });
        try {
            await expect(unwired.api.selectActionInput(request)).rejects.toMatchObject({ code: 'unsupported_method' });
            expect(Modal.show).not.toHaveBeenCalled();
        } finally { unwired.dispose(); }
        const adapter = createCanonicalPluginReactNativeHostApiAdapter({
            surface,
            requestSurface, requestIdPrefix: 'recipe-request', handleRequest: host.handleRequest, installedMethods: host.installedMethods,
        });
        let selection: ReturnType<PluginUiHostApi['selectActionInput']> | undefined;
        let earlySettlement: unknown = null;
        const plugin = await renderScreen(<RecipeRequestingPlugin api={adapter.api} request={() => {
            selection = adapter.api.selectActionInput(request);
            void selection.then(value => { earlySettlement = value; }, error => { earlySettlement = error; });
        }} />);
        try {
            vi.mocked(Modal.show).mockClear();
            await act(async () => { plugin.findByType(RoundButton).props.onPress(); });
            await waitForHomeGovernance(() => expect(vi.mocked(Modal.show).mock.calls.length > 0 || earlySettlement !== null).toBe(true));
            expect(earlySettlement).toBeNull();
            expect(Modal.show).toHaveBeenCalledTimes(1);
            const config = vi.mocked(Modal.show).mock.calls[0]![0];
            expect(config.component).toBe(SessionServerStartDraftComposerModal);
            expect(config.props?.target).toEqual({ serverId, machineId: 'machine-1' });
            // Modal.show is the actual UI presentation boundary; its selected component and props are mounted unchanged.
            const chrome: { current: CustomModalChromeConfig | null } = { current: null };
            const dialog = await renderScreen(React.createElement(config.component, { ...config.props, onClose: () => {},
                setChrome: (value: CustomModalChromeConfig) => { chrome.current = value; } }));
            try {
                await waitForHomeGovernance(() => expect(dialog.findAllByType(SessionAuthoringControls).length,
                    dialog.getTextContent()).toBe(2));
                const facts = dialog.findAllByType(SessionAuthoringControls)[0]!.props.facts;
                expect(facts.agentPickerContext).toMatchObject({ serverId, machineId: 'machine-1' });
                expect(facts.agentTargets).toEqual(expect.arrayContaining([expect.objectContaining({
                    label: 'Recipe Agent', target: { kind: 'agent', identity: { pluginId: 'acme.recipe', localId: 'agent' } },
                })]));
                const fields = dialog.findAllByType(SessionAuthoringControls).flatMap(node => node.props.fields);
                expect(fields).toEqual(expect.arrayContaining(['modelSelection', 'sessionConfigOptionOverrides', 'allowedTools', 'unlistedTools']));
                for (const field of ['agentTarget', 'allowedTools', 'unlistedTools']) {
                    expect(dialog.findHostByTestId(`server-start-draft-control-${field}-row`)).not.toBeNull();
                }
                expect(dialog.findByTestId('server-start-draft-folder')).not.toBeNull();
                expect(dialog.findByType(PathSelectionList).props).toMatchObject({ serverId, machineId: 'machine-1' });
                expect(dialog.findAllByType(Item).some(node => node.props.selected === true && typeof node.props.onPress === 'function')).toBe(true);
                if (chrome.current?.kind !== 'card') throw new Error('Missing composer card');
                const footer = await renderScreen(<>{chrome.current.footer}</>);
                try {
                    const submit = footer.findAllByType(RoundButton).find(node => node.props.title === 'common.create')!;
                    expect(submit.props.disabled).toBe(false);
                    await act(async () => { submit.props.onPress(); });
                } finally { await footer.unmount(); }
                await expect(selection).resolves.toEqual({ kind: 'serverStartDraft', draft });
            } finally { await dialog.unmount(); }
        } finally { adapter.dispose(); await plugin.unmount(); }
    });

    it('retains Folder, configuration and tool policy through save/reopen and rejects a second Home folder', async () => {
        const draft = recipe();
        const mounted = await mount(draft);
        await waitForHomeGovernance(() => expect(mounted.screen.findAllByType(DropdownMenu).some(node =>
            node.props.items?.some((item: { id: string }) => item.id === 'intake'))).toBe(true));
        expect(await mounted.submit()).toEqual(draft);
        await mounted.screen.unmount();
        const changed = await mount(draft);
        await act(async () => { changed.screen.findByType(PathSelectionList).props.onChangeDraftPath('/elsewhere'); });
        expect(await changed.submit()).toEqual({ ...draft, directory: { kind: 'path', path: '/elsewhere' }, organizationPlacement: { folderId: null, tagIds: ['mail'] } });
        await changed.screen.unmount();
        for (const existing of [false, true]) {
            const configurationDraft = recipe(existing);
            const editing = await mount(configurationDraft);
            await waitForHomeGovernance(() => expect(editing.screen.findAllByType(SessionAuthoringControls).length).toBeGreaterThan(0));
            await act(async () => { editing.screen.findAllByType(SessionAuthoringControls)[0]!.props.onChangeField(
                'sessionConfigOptionOverrides', { v: 1, updatedAt: 12, overrides: { reasoning: { value: 'high', updatedAt: 12 } } },
            ); });
            const emitted = await editing.submit();
            expect(emitted.configuration?.options).toEqual({ reasoning: { value: 'high', updatedAtMs: 12 } });
            if (existing) expect(emitted.configuration?.providerSessionResume).toEqual(configurationDraft.configuration?.providerSessionResume);
            await editing.screen.unmount();
            const reopened = await mount(emitted);
            await waitForHomeGovernance(() => expect(reopened.screen.findAllByType(SessionAuthoringControls).length).toBeGreaterThan(0));
            expect(reopened.screen.findAllByType(SessionAuthoringControls)[0]!.props.values.sessionConfigOptionOverrides.overrides.reasoning.value).toBe('high');
            expect(await reopened.submit()).toEqual(emitted);
            await reopened.screen.unmount();
        }

        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', active: true, activeAt: Date.now() })], true, { sourceServerId: otherServerId });
        const otherHome = await mount(draft, { serverId: otherServerId, machineId: 'machine-1' });
        await waitForHomeGovernance(() => expect(otherHome.screen.findAllByType(SessionAuthoringControls).length).toBeGreaterThan(0));
        expect(otherHome.screen.findAllByType(DropdownMenu).some(node => node.props.items?.some((item: { id: string }) => item.id === 'intake'))).toBe(false);
        expect((await otherHome.submit()).organizationPlacement).toEqual({ folderId: null, tagIds: ['mail'] });
        await otherHome.screen.unmount();
    });
});
