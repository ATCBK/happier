import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAgentStaticModels } from '@happier-dev/agents';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
    ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, createProviderConnectionsDescribeFixture } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { clearActiveUnsavedChangesGuard, setActiveUnsavedChangesGuard } from '@/utils/navigation/runGuardedNavigation';

installSettingsViewCommonModuleMocks({ storage: 'real',
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ pathname: '/settings/providers/new' }).module;
    },
});
// Native recycler layout is a platform boundary; exercise the real row/header renderers.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});
// Machine transport is a genuine boundary. No Account operation may reach it.
const machineRpcWithServerScope = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({ machineRpcWithServerScope }));
const account = createProviderSettingsAccountHarness();
const accountConnectionId = ProviderConnectionIdSchema.parse('pc_account');
await loadSyncSingletonForTests();
// Warm the real screen graphs during collection, outside the behavior-test budget.
const [{ ProviderConnectionDetailScreen }, { AgentModelsScreen }] = await Promise.all([
    import('@/components/settings/providers/ProviderConnectionDetailScreen'),
    import('@/components/settings/agents/AgentModelsScreen'),
]);
afterEach(async () => { standardCleanup(); clearActiveUnsavedChangesGuard(); await account.reset(); machineRpcWithServerScope.mockReset(); });

function customTemplate() {
    return buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
        name: 'Account source', baseUrl: 'https://models.example.test/v1', requiresApiKey: false });
}

describe('Account Provider UI actions without a machine', () => {
    it('writes favorites through the Account Action and refuses a retained writer after Account retirement', async () => {
        const opaque = { v: 99, futureWriterField: 'keep' };
        const { serverId } = await account.restore({ catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, machines: [],
            settings: { favoriteModelSelectionsV1: [opaque] } });
        // Stateful HTTP CAS is the genuine boundary. The stock Provider harness only reads Settings.
        const { AccountSettingsV2UpdateRequestSchema } = await import('@happier-dev/protocol/account/settings/accountSettingsApiV2');
        let persisted: Record<string, unknown> = { favoriteModelSelectionsV1: [opaque] };
        let version = 1;
        account.home.answer(serverId, '/v2/account/settings', {
            select: () => ({ body: { version, content: { t: 'plain', v: persisted } } }),
        });
        account.home.answer(serverId, 'POST /v2/account/settings', { select: input => {
            const request = AccountSettingsV2UpdateRequestSchema.parse(input);
            if (request.expectedVersion !== version) return { status: 409, body: {
                success: false, error: 'version-mismatch', currentVersion: version, currentContent: { t: 'plain', v: persisted },
            } };
            if (request.content?.t !== 'plain') throw new Error('Expected a keyless Plain Account favorite write');
            persisted = request.content.v;
            version += 1;
            return { body: { success: true, version } };
        } });
        const { useApplyFavoriteModelSelectionReplacementIntent } = await import('@/sync/store/settingsWriters');
        const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
        const { useAccountSettingsScope } = await import('@/sync/store/settingsWriters');
        const hook = await renderHook(() => ({ writer: useApplyFavoriteModelSelectionReplacementIntent(),
            ready: useMountedActionExecution(useAccountSettingsScope()).ready }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        const selection = { selection: { v: 1 as const, updatedAt: 5,
            ref: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'favorite-model' } } };
        await act(async () => { await hook.getCurrent().writer({ base: [], proposed: [selection] }); });
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().settings.currentFavoriteModelSelectionsV1).toEqual([selection]);
        const { readRetainedFavoriteModelSelectionsV1 } = await import('@/sync/domains/settings/sessionAuthoringSelectionPersistence');
        expect(readRetainedFavoriteModelSelectionsV1(storage.getState().settings)).toEqual([opaque, selection]);
        const retained = hook.getCurrent().writer;
        await account.reset();
        await expect(retained({ base: [selection], proposed: [] })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
    it('reads Provider approval operands by their Account names without exposing ids or boolean literals', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_approval_view', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Work source', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }] });
        const { serverId } = await account.restore({ catalog, machines: [] });
        const { useProviderCatalogForServer } = await import('@/sync/store/useProviderCatalog');
        const catalogHook = await renderHook(() => useProviderCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(catalogHook.getCurrent()?.data?.connections[0]?.displayName).toBe('Work source'));
        const { ActionApprovalFieldsCard } = await import('@/components/approvals/ActionApprovalFieldsCard');
        const { describeApprovalActionFields } = await import('@/components/approvals/approvalFieldValues');
        const screen = await renderScreen(<ActionApprovalFieldsCard serverId={serverId} presentation={describeApprovalActionFields({
            actionId: 'providers.connections.enabled.set', actionArgs: { action: 'setEnabled', connectionId: 'pc_approval_view', enabled: true, scope: 'account' },
        })} />);
        expect(screen.getTextContent()).toContain('Work source');
        expect(screen.getTextContent()).not.toContain('pc_approval_view');
        expect(screen.getTextContent()).not.toContain('true');
        expect(screen.getTextContent()).not.toContain('setEnabled');
        const foreign = await renderScreen(<ActionApprovalFieldsCard serverId="another-home" presentation={describeApprovalActionFields({
            actionId: 'providers.connections.delete', actionArgs: { action: 'delete', connectionId: 'pc_approval_view' },
        })} />);
        expect(foreign.getTextContent()).not.toContain('Work source');
        const creation = await renderScreen(<ActionApprovalFieldsCard serverId={serverId} presentation={describeApprovalActionFields({
            actionId: 'providers.connections.create_contribution', actionArgs: { action: 'createContribution', connectionId: 'pc_new',
                contributionKey: 'happier.provider.deepseek/deepseek', displayName: 'DeepSeek', savedSecretId: null, enable: true },
        })} />);
        expect(creation.getTextContent()).toContain('DeepSeek');
        expect(creation.getTextContent()).not.toContain('happier.provider.deepseek/deepseek');
        expect(creation.getTextContent()).not.toContain('pc_new');
        const custom = await renderScreen(<ActionApprovalFieldsCard serverId={serverId} presentation={describeApprovalActionFields({
            actionId: 'providers.connections.create_custom', actionArgs: { action: 'createCustom', connectionId: 'pc_custom',
                template: customTemplate(), savedSecretId: null, enable: true, manualModels: [] },
        })} />);
        expect(custom.getTextContent()).not.toContain('[]');
        expect(custom.getTextContent()).not.toContain('true');
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
    it('retains the dirty author while reviewing approval and settles rejected writes without replay', async () => {
        const { serverId } = await account.restore({ catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, machines: [],
            settings: { actionsSettingsV1: { v: 1, actions: {
                'providers.connections.create_custom': { approvalRequiredSurfaces: ['ui'] },
            } } },
        });
        const [{ WorkspaceProvider }, { DestinationInstanceHost }, { resolveCompactAppDestinations }] = await Promise.all([
            import('@/components/appShell/workspace/WorkspaceProvider'), import('@/components/appShell/workspace/DestinationInstanceHost'),
            import('@/components/appShell/destinations/compactAppDestinationCatalog'),
        ]);
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        let workspace: WorkspaceNavigationContextValue | null = null;
        let sourceTabId: string | null = null;
        function Wrapper({ children }: React.PropsWithChildren) {
            return <WorkspaceProvider enabled catalog={catalog}>{navigation => {
                workspace = navigation;
                sourceTabId ??= navigation.state.groups[navigation.state.focusedGroupId]!.activeTabId;
                const tab = navigation.state.tabs[sourceTabId]!;
                return <DestinationInstanceHost tabId={tab.id} ref={tab.target} pathname="/settings/providers/new"
                    focused visible navigation={navigation.navigationForTab(tab.id)}>{children}</DestinationInstanceHost>;
            }}</WorkspaceProvider>;
        }
        const { useProviderConnectionMutation } = await import('./useProviderConnectionMutation');
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const refresh = async () => {};
        const resolveTarget = () => null;
        const hook = await renderHook(() => ({ mutation: useProviderConnectionMutation({ serverId, resolveTarget, refresh }),
            ready: useProviderActionClient(serverId).ready }), { wrapper: Wrapper });
        await waitForHomeGovernance(() => expect(hook.getCurrent().ready).toBe(true));
        await waitForHomeGovernance(() => expect(workspace!.active).toBe(true));
        const dirty = { current: true };
        const requestDecision = vi.fn(async () => 'keepEditing' as const);
        setActiveUnsavedChangesGuard({ isDirtyRef: dirty, requestDecision, tag: 'Provider.authoring.approval' });
        let pending: ReturnType<ReturnType<typeof useProviderConnectionMutation>['run']> | undefined;
        await act(async () => { pending = hook.getCurrent().mutation.run({ action: 'createCustom', connectionId: 'pc_approval',
            template: customTemplate(), savedSecretId: null, enable: false, manualModels: [] }); });
        await waitForHomeGovernance(() => expect(account.home.artifacts(serverId).list()).toHaveLength(1));
        await waitForHomeGovernance(() => expect(hook.getCurrent().mutation.pendingApproval).not.toBeNull());
        expect(requestDecision).not.toHaveBeenCalled();
        await waitForHomeGovernance(() => {
            const state = workspace!.state;
            const active = state.tabs[state.groups[state.focusedGroupId]!.activeTabId]!;
            expect(active.id).toBe(sourceTabId);
        });
        const state = workspace!.state;
        expect(state.tabs[sourceTabId!]).toBeDefined();
        expect(dirty.current).toBe(true);
        expect(hook.getCurrent().mutation.isPending('createCustom:pc_approval')).toBe(true);
        // The author can say what it waits for and reopen the same approval (P1#7).
        const artifactId = hook.getCurrent().mutation.pendingApproval!.artifactId;
        expect(hook.getCurrent().mutation.pendingApproval?.href)
            .toContain(`/inbox/approvals/${encodeURIComponent(artifactId)}`);
        await expect(decideApprovalAsInbox(serverId, artifactId, 'reject')).resolves.toMatchObject({ ok: true });
        await act(async () => { await pending!; });
        expect(hook.getCurrent().mutation.isPending('createCustom:pc_approval')).toBe(false);
        expect(hook.getCurrent().mutation.pendingApproval).toBeNull();
        expect(dirty.current).toBe(true);
    });

    it('keeps the Account connection readable when its selected-machine augmentation fails', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const { serverId } = await account.restore({ catalog, serverIdentityId: 'srv_provider_machine',
            machines: [createMachineFixture({ id: 'machine-a', active: true, activeAt: Date.now() })] });
        machineRpcWithServerScope.mockResolvedValue({ status: 'error', error: createProviderErrorV1('provider_connection_invalid') });
        const { useProviderConnections } = await import('./useProviderConnections');
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: 'machine-a', serverId,
            connectionId: 'pc_account' }));
        await waitForHomeGovernance(() => expect(machineRpcWithServerScope).toHaveBeenCalled());
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().data?.connections[0]).toMatchObject({ connectionId: 'pc_account', displayName: 'Account source',
            authorized: false, runtime: { health: 'not_checked' } });
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent()).toMatchObject({ machineError: { code: 'provider_connection_invalid' }, loading: false });
        // A daemon's lagging catalog census cannot delete the fresh Account editor either.
        machineRpcWithServerScope.mockResolvedValue(createProviderConnectionsDescribeFixture({ connections: [] }));
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent().data?.connections[0]?.connectionId).toBe('pc_account');
        expect(hook.getCurrent().machineError).toBeNull();
        machineRpcWithServerScope.mockResolvedValue({ status: 'error', error: createProviderErrorV1('provider_connection_invalid') });
        await account.selectMachine(serverId, 'machine-a');
        const screen = await renderScreen(<ProviderConnectionDetailScreen connectionId="pc_account" />);
        await waitForHomeGovernance(() => expect(screen.findAllByTestId('provider-error:provider_connection_invalid').length).toBeGreaterThan(0));
        await waitForHomeGovernance(() => expect(screen.findByTestId('provider-connection-name')).not.toBeNull());
        expect(screen.findByTestId('provider-connection-header')).not.toBeNull();
    });

    it('initializes a fresh Account catalog before reading sources without another mounted observer', async () => {
        let catalog: ReturnType<typeof ProviderConnectionsCatalogV1Schema.parse> | null = null;
        const { serverId } = await account.restore({ machines: [] });
        const [{ resetProviderCatalogEngineForTests }, { resetProviderCatalogSnapshotsForTests }] = await Promise.all([
            import('@/sync/engine/settings/providerCatalogEngine'), import('@/sync/store/settings/providerCatalogSnapshot'),
        ]);
        resetProviderCatalogEngineForTests();
        resetProviderCatalogSnapshotsForTests();
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: catalog
                ? { status: 'present', revision: 1, content: { t: 'plain', v: catalog } }
                : { status: 'absent' } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe('absent');
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account initialization');
                catalog = mutation.content.v;
                return { body: { status: 'updated', revision: 1, cursor: 1 } };
            },
        });
        const { useProviderConnections } = await import('./useProviderConnections');
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().data?.connections).toEqual([]);
        expect(catalog).not.toBeNull();
        const [{ getProviderCatalogSnapshot }, { getActiveServerAccountScope }] = await Promise.all([
            import('@/sync/store/settings/providerCatalogSnapshot'), import('@/sync/domains/scope/activeServerAccountScope'),
        ]);
        expect(getProviderCatalogSnapshot(getActiveServerAccountScope())).toMatchObject({ status: 'ready', revision: 1 });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('projects contributed brand tokens through the Account read into connection consumers', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_brand', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
                role: 'named', displayName: 'My DeepSeek', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const { serverId } = await account.restore({ catalog, machines: [] });
        const { useProviderConnections } = await import('./useProviderConnections');
        const { buildProviderCollection } = await import('@/components/settings/providers/collection/providerCollectionModel');
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().data?.connections[0]?.icon).toBe('deepseek'));
        expect(buildProviderCollection({ data: hook.getCurrent().data, query: '', localDiscoveryEnabled: false })
            .connections[0]?.icon).toBe('deepseek');
        for (const token of ['openai', 'openrouter', 'ollama']) {
            expect(hook.getCurrent().data?.available.find(row => row.contributionKey.endsWith(`/${token}`))?.icon).toBe(token);
        }
        expect(hook.getCurrent().data?.available.find(row => row.contributionKey.endsWith('/cliproxyapi'))?.icon).toBeNull();
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('projects a populated contributed source into Agent Models without a machine', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_deepseek', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
                role: 'named', displayName: 'QA DeepSeek', displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const { serverId } = await account.restore({ catalog, machines: [] });
        const { useProviderModelProjection } = await import('./useProviderModelProjection');
        const hook = await renderHook(() => useProviderModelProjection({ enabled: true, machineId: null, serverId,
            agentTargetKey: 'agent:happier.agent.claude/claude', mode: 'management' }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().loading).toBe(false));
        expect(hook.getCurrent().error).toBeNull();
        expect(hook.getCurrent().data?.groups).toEqual(expect.arrayContaining([
            expect.objectContaining({ connectionId: 'pc_deepseek' }),
        ]));
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('offers retry for an unavailable Account catalog and recovers the same mounted reader', async () => {
        const { serverId } = await account.restore({ machines: [] });
        let reachable = false;
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => reachable
                ? { body: { status: 'present', revision: 1, content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } }
                : { body: { error: 'unavailable' }, status: 503 },
        });
        const { useProviderConnections } = await import('./useProviderConnections');
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().error).not.toBeNull());
        expect(hook.getCurrent()).toMatchObject({ loading: false, error: { retryable: true, action: 'retry' } });
        reachable = true;
        await act(async () => { await hook.getCurrent().refresh(); });
        expect(hook.getCurrent()).toMatchObject({ loading: false, error: null, data: { connections: [] } });
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('opens Agent Models with native models and Account sources when no machine exists', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
            manualModelsByConnectionId: { pc_account: [{ id: 'manual-model', addedAt: 1 }] },
        });
        const { serverId } = await account.restore({ catalog, machines: [] });
        // Screen feature admission follows the Home view selection, not just
        // the Account connection restored for the Action transport.
        await account.home.selectHomes([serverId]);
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const ready = await renderHook(() => useProviderActionClient(serverId));
        await waitForHomeGovernance(() => expect(ready.getCurrent().ready).toBe(true));
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId="codex" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models')).not.toBeNull());
        const nativeModel = getAgentStaticModels('codex')[0]!;
        expect(screen.getTextContent()).toContain(nativeModel.name || nativeModel.id);
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models-source-visibility:pc_account')).not.toBeNull());
        expect(screen.findByTestId('agent-models')).not.toBeNull();
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
    it('reads saved connection identity and manual models without asserting runtime authorization', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
            manualModelsByConnectionId: { pc_account: [{ id: 'manual-model', addedAt: 1 }] },
        });
        const { serverId } = await account.restore({ catalog, machines: [] });
        const [{ useProviderConnections }, { useProviderConnectionModels }, { useProviderActionClient }, { useProviderModelProjection }] = await Promise.all([
            import('./useProviderConnections'), import('./useProviderConnectionModels'), import('@/providers/actions/useProviderActionClient'), import('./useProviderModelProjection'),
        ]);
        const hook = await renderHook(() => ({
            connections: useProviderConnections({ enabled: true, machineId: null, serverId }),
            models: useProviderConnectionModels({ enabled: true, machineId: null, serverId, connectionId: 'pc_account' }),
            actions: useProviderActionClient(serverId),
            projection: useProviderModelProjection({ enabled: true, machineId: null, serverId,
                agentTargetKey: 'agent:happier.agent.codex/codex', mode: 'management' }),
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().actions.ready).toBe(true));
        await act(async () => { expect((await hook.getCurrent().connections.refresh())?.status).toBe('success'); });
        expect(hook.getCurrent().connections.data?.connections[0]?.connectionId).toBe('pc_account');
        expect(hook.getCurrent().connections.data?.connections[0]).toMatchObject({ authorized: false, runtime: { health: 'not_checked' } });
        await act(async () => { expect((await hook.getCurrent().models.refreshWithResult())?.status).toBe('success'); });
        expect(hook.getCurrent().models.models).toMatchObject([{ id: 'manual-model', source: 'manual', loadState: 'unknown' }]);
        await act(async () => { expect((await hook.getCurrent().projection.refreshWithResult())?.status).toBe('success'); });
        expect(hook.getCurrent().projection.data?.groups).toMatchObject([{
            connectionId: 'pc_account', modelLoadAction: 'machine_required',
            authorization: { authorized: false }, rows: [{ ref: { modelId: 'manual-model' }, loadState: 'unknown' }],
        }]);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('creates, edits, adds manual models, reloads and deletes through the Account catalog', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse(DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1);
        let revision = 1;
        let writes = 0;
        const { serverId } = await account.restore({ catalog, machines: [], waivedActions: [
            'providers.connections.create_custom', 'providers.connections.update', 'providers.connections.delete',
        ] });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                expect(mutation.expectedRevision).toBe(revision);
                if (mutation.content?.t !== 'plain') throw new Error('Expected keyless Plain Account write');
                writes += 1;
                catalog = mutation.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const [{ useProviderConnections }, { useProviderConnectionMutation }, { useProviderActionClient }] = await Promise.all([
            import('./useProviderConnections'), import('./useProviderConnectionMutation'), import('@/providers/actions/useProviderActionClient'),
        ]);
        const resolveTarget = () => null;
        const hook = await renderHook(() => {
            const connections = useProviderConnections({ enabled: true, machineId: null, serverId });
            const refresh = React.useCallback(async () => { await connections.refresh(); }, [connections.refresh]);
            return { connections, mutation: useProviderConnectionMutation({ resolveTarget, serverId, refresh }),
                actions: useProviderActionClient(serverId) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().actions.ready).toBe(true));
        await act(async () => {
            const result = await hook.getCurrent().mutation.run({ action: 'createCustom', connectionId: 'pc_account',
                template: customTemplate(), savedSecretId: null, enable: false, manualModels: [] });
            expect(result?.status).toBe('success');
        });
        const created = catalog.connections[0]!;
        await act(async () => {
            const result = await hook.getCurrent().mutation.run({ action: 'update', connectionId: created.id,
                expectedRevision: created.revision, displayName: 'Renamed source', displayNameMode: 'custom' });
            expect(result?.status).toBe('success');
        });
        await act(async () => {
            const result = await hook.getCurrent().actions.mutateProviderModelSettings({ serverId, request: {
                action: 'manualAdd', connectionId: created.id, expectedConnectionRevision: catalog.connections[0]!.revision,
                models: [{ id: 'added-model' }],
            } });
            expect(result.status).toBe('success');
            await hook.getCurrent().connections.refresh();
        });
        expect(catalog.manualModelsByConnectionId[accountConnectionId]).toMatchObject([{ id: 'added-model' }]);
        const beforeTemplateEdit = catalog.connections[0]!;
        const manualModels = catalog.manualModelsByConnectionId[accountConnectionId];
        const replacement = buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
            name: 'Corrected template', baseUrl: 'https://corrected.example.test/v1', requiresApiKey: false });
        await act(async () => {
            const result = await hook.getCurrent().mutation.updateCustomTemplate({
                connectionId: created.id, expectedRevision: beforeTemplateEdit.revision, template: replacement,
            });
            expect(result).toMatchObject({ status: 'success', connection: {
                revision: beforeTemplateEdit.revision + 1,
                endpoints: [{ baseUrl: 'https://corrected.example.test/v1' }],
            } });
        });
        expect(catalog.connections[0]).toMatchObject({
            source: { kind: 'custom', template: replacement }, revision: beforeTemplateEdit.revision + 1,
        });
        expect(catalog.manualModelsByConnectionId[accountConnectionId]).toEqual(manualModels);
        expect(hook.getCurrent().connections.data?.connections[0]).toMatchObject({
            displayName: 'Renamed source', revision: beforeTemplateEdit.revision + 1,
            endpoints: [{ baseUrl: 'https://corrected.example.test/v1' }],
        });
        const committedCatalog = catalog;
        const committedRowRevision = revision;
        const committedWrites = writes;
        await act(async () => {
            const result = await hook.getCurrent().mutation.updateCustomTemplate({
                connectionId: created.id, expectedRevision: beforeTemplateEdit.revision, template: customTemplate(),
            });
            expect(result).toBeNull();
        });
        expect(hook.getCurrent().mutation.error).toMatchObject({ code: 'provider_connection_changed', connectionId: created.id });
        expect(writes).toBe(committedWrites);
        expect(revision).toBe(committedRowRevision);
        expect(catalog).toEqual(committedCatalog);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
        await hook.unmount();
        const reopened = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await waitForHomeGovernance(() => expect(reopened.getCurrent().data?.connections[0]?.displayName).toBe('Renamed source'));
        expect(reopened.getCurrent().data?.connections[0]).toMatchObject({
            revision: beforeTemplateEdit.revision + 1, endpoints: [{ baseUrl: 'https://corrected.example.test/v1' }],
        });
        expect(catalog.manualModelsByConnectionId[accountConnectionId]).toEqual(manualModels);
        const writer = await renderHook(() => {
            const refresh = React.useCallback(async () => { await reopened.getCurrent().refresh(); }, [reopened]);
            return useProviderConnectionMutation({ resolveTarget, serverId, refresh });
        });
        await act(async () => {
            expect((await writer.getCurrent().run({ action: 'delete', connectionId: created.id }))?.status).toBe('success');
        });
        expect(catalog.connections).toEqual([]);
        expect(reopened.getCurrent().data?.connections).toEqual([]);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('reads and edits the Account source while the selected machine is offline', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        let revision = 1;
        const { serverId } = await account.restore({ catalog, serverIdentityId: 'srv_provider_account',
            machines: [createMachineFixture({ id: 'machine-offline', kind: 'persistent', active: false, activeAt: 1 })],
            waivedActions: ['providers.connections.update'],
        });
        await account.selectMachine(serverId, 'machine-offline');
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account write');
                catalog = mutation.content.v;
                revision += 1;
                return { body: { status: 'updated', revision, cursor: revision } };
            },
        });
        const [{ useProviderSettingsTarget }, { useProviderConnections }, { useProviderConnectionMutation }, { useProviderActionClient }] = await Promise.all([
            import('./targetMachine'), import('./useProviderConnections'), import('./useProviderConnectionMutation'), import('@/providers/actions/useProviderActionClient'),
        ]);
        const hook = await renderHook(() => {
            const target = useProviderSettingsTarget();
            const connections = useProviderConnections({ enabled: true, machineId: target.machineId, serverId: target.serverId });
            const refresh = React.useCallback(async () => { await connections.refresh(); }, [connections.refresh]);
            return { target, connections, actions: useProviderActionClient(serverId),
                mutation: useProviderConnectionMutation({ resolveTarget: target.resolveCurrentTarget, serverId: target.serverId, refresh }) };
        });
        await waitForHomeGovernance(() => expect(hook.getCurrent().actions.ready).toBe(true));
        expect(hook.getCurrent().target.selection.selectedTarget?.machineId).toBe('machine-offline');
        expect(hook.getCurrent().target.machineId).toBeNull();
        await act(async () => { expect((await hook.getCurrent().connections.refresh())?.status).toBe('success'); });
        await act(async () => {
            expect((await hook.getCurrent().mutation.run({ action: 'update', connectionId: 'pc_account',
                expectedRevision: 1, displayName: 'Offline-edited source', displayNameMode: 'custom' }))?.status).toBe('success');
        });
        expect(hook.getCurrent().connections.data?.connections[0]?.displayName).toBe('Offline-edited source');
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('preserves a manual-model draft after a no-machine revision conflict', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        const { serverId } = await account.restore({ catalog, machines: [] });
        const { useProviderConnectionModelsSection } = await import('@/components/settings/providers/models/useProviderConnectionModelsSection');
        const hook = await renderHook(() => useProviderConnectionModelsSection({
            enabled: true, connectionId: 'pc_account', machineId: null, serverId,
            connection: { providerName: 'Account source', displayName: 'Account source', role: 'named',
                displayNameMode: 'custom', probeCapability: 'catalog' },
            resolveCurrentTarget: () => null,
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().manualModelPolicy).toBe('allowed'));
        await act(async () => { hook.getCurrent().onManualModelTextChange('my-model'); });
        // A second client updated this same connection while the local draft was open.
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 2, content: { t: 'plain', v: {
                ...catalog, connections: [{ ...catalog.connections[0], revision: 2 }],
            } } },
        });
        await act(async () => { expect(await hook.getCurrent().manualDraft.save()).toBe(false); });
        expect(hook.getCurrent().error?.code).toBe('provider_connection_changed');
        expect(hook.getCurrent().manualModelText).toBe('my-model');
        expect(hook.getCurrent().manualDraft.dirtyRef.current).toBe(true);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });

    it('reads after an unknown Account write without replaying it or discarding the manual draft', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        let revision = 1;
        let writes = 0;
        const { serverId } = await account.restore({ catalog, machines: [] });
        account.home.answer(serverId, `GET ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: () => ({ body: { status: 'present', revision, content: { t: 'plain', v: catalog } } }),
        });
        account.home.answer(serverId, `POST ${PROVIDER_CONNECTIONS_ROWS_ROUTE_V1}`, {
            select: input => {
                const mutation = ProviderConnectionsRowMutationV1Schema.parse(input);
                if (mutation.content?.t !== 'plain') throw new Error('Expected Plain Account write');
                writes += 1;
                catalog = mutation.content.v;
                revision += 1;
                // The Home committed, but its receipt was lost in transit.
                return { dispatchThenFail: true };
            },
        });
        const { useProviderConnectionModelsSection } = await import('@/components/settings/providers/models/useProviderConnectionModelsSection');
        const hook = await renderHook(() => useProviderConnectionModelsSection({
            enabled: true, connectionId: 'pc_account', machineId: null, serverId,
            connection: { providerName: 'Account source', displayName: 'Account source', role: 'named',
                displayNameMode: 'custom', probeCapability: 'catalog' }, resolveCurrentTarget: () => null,
        }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().manualModelPolicy).toBe('allowed'));
        await act(async () => { hook.getCurrent().onManualModelTextChange('my-model'); });
        await act(async () => { expect(await hook.getCurrent().manualDraft.save()).toBe(false); });
        expect(hook.getCurrent().error).toMatchObject({ code: 'provider_rpc_mutation_outcome_unknown', action: 'review_current_state' });
        expect(hook.getCurrent().errorRetry).toBeUndefined();
        expect(hook.getCurrent().modelCount).toBe(1);
        expect(hook.getCurrent().manualModelText).toBe('my-model');
        await act(async () => { await hook.getCurrent().errorReviewCurrentState?.(); });
        expect(writes).toBe(1);
        expect(machineRpcWithServerScope).not.toHaveBeenCalled();
    });
});
