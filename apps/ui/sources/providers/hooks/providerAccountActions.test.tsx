import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAgentStaticModels } from '@happier-dev/agents';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import {
    DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    PROVIDER_CONNECTIONS_ROWS_ROUTE_V1,
    ProviderConnectionsCatalogV1Schema,
    ProviderConnectionsRowMutationV1Schema,
} from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { createProviderSettingsAccountHarness, createProviderSettingsHarness, installProviderSettingsRpcBoundary } from '@/dev/testkit/harness/providerSettingsHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { renderScreen } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { installSettingsViewCommonModuleMocks } from '@/components/settings/settingsViewTestHelpers';
import { buildCustomProviderTemplate, createCustomProviderDraft } from '@/providers/authoring/state';

installSettingsViewCommonModuleMocks({ storage: 'real' });
// The model page uses a native recycler; render its real row internals through the canonical boundary adapter.
vi.mock('@legendapp/list/react-native', async (importOriginal) => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>() }).module;
});
// Only Socket transport is substituted; scoped Machine routing and receipts stay real.
const providerHarness = createProviderSettingsHarness({ machines: [] });
installProviderSettingsRpcBoundary(providerHarness);
const account = createProviderSettingsAccountHarness();
beforeAll(async () => {
    await loadSyncSingletonForTests();
    // Admit the real screen graph once, outside each Account operation's test budget.
    await import('@/components/settings/agents/AgentModelsScreen');
});
afterEach(async () => { standardCleanup(); await account.reset(); providerHarness.reset(); });

function customTemplate() {
    return buildCustomProviderTemplate({ ...createCustomProviderDraft('openai-responses'),
        name: 'Account source', baseUrl: 'https://models.example.test/v1', requiresApiKey: false });
}

describe('Account Provider UI actions without a machine', () => {
    it('initializes a fresh Account catalog through its existing observer before reading sources', async () => {
        const { serverId } = await account.restore({ catalog: null, machines: [] });
        const { useProviderCatalogForServer } = await import('@/sync/store/useProviderCatalog');
        const observer = await renderHook(() => useProviderCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(observer.getCurrent()).toMatchObject({ status: 'ready', revision: 1 }));
        const { useProviderConnections } = await import('./useProviderConnections');
        const hook = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await waitForHomeGovernance(() => expect(hook.getCurrent().data?.connections).toEqual([]));
        expect(account.catalogMutations).toHaveLength(1);
        expect(account.catalogMutations[0]).toMatchObject({ expectedRevision: 'absent', sourceSettingsVersion: 1,
            content: { t: 'plain', v: { connections: [] } } });
        expect(account.readCatalogRow()).toMatchObject({ revision: 1, content: { t: 'plain', v: { connections: [] } } });
        const [{ getProviderCatalogSnapshot }, { getActiveServerAccountScope }] = await Promise.all([
            import('@/sync/store/settings/providerCatalogSnapshot'), import('@/sync/domains/scope/activeServerAccountScope'),
        ]);
        expect(getProviderCatalogSnapshot(getActiveServerAccountScope())).toMatchObject({ status: 'ready', revision: 1 });
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('opens Agent Models with native models and Account sources when no machine exists', async () => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
            manualModelsByConnectionId: { pc_account: [{ id: 'manual-model', addedAt: 1 }] },
        });
        const { serverId } = await account.restore({ catalog, machines: [], waivedActions: ['providers.defaults.set'] });
        let settingsWrites = 0;
        account.home.answer(serverId, 'POST /v2/account/settings', { select: input => {
            const mutation = AccountSettingsV2UpdateRequestSchema.parse(input);
            expect(mutation.expectedVersion).toBe(1);
            expect(mutation.content?.t).toBe('plain');
            settingsWrites += 1;
            account.home.answer(serverId, 'GET /v2/account/settings', {
                body: { version: 2, content: mutation.content },
            });
            return { body: { success: true, version: 2 } };
        } });
        await account.selectMachine(serverId, null, 'agents');
        const [{ useMachineAdministrationTargetSelection }, { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 }] = await Promise.all([
            import('@/sync/domains/machines/administration/useTargetSelection'),
            import('@/sync/domains/machines/administration/selectionPreferences'),
        ]);
        const selection = await renderHook(() => useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents));
        expect(selection.getCurrent().state.kind).toBe('unselected');
        const { useProviderActionClient } = await import('@/providers/actions/useProviderActionClient');
        const ready = await renderHook(() => useProviderActionClient(serverId));
        await waitForHomeGovernance(() => expect(ready.getCurrent().ready).toBe(true));
        const { AgentModelsScreen } = await import('@/components/settings/agents/AgentModelsScreen');
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey="agent:happier.agent.codex/codex" runtimeAgentId="codex" />);
        const [{ getProviderCatalogSnapshot }, { getActiveServerAccountScope }] = await Promise.all([
            import('@/sync/store/settings/providerCatalogSnapshot'), import('@/sync/domains/scope/activeServerAccountScope'),
        ]);
        await waitForHomeGovernance(() => expect(getProviderCatalogSnapshot(getActiveServerAccountScope())).toMatchObject({ status: 'ready', revision: 1 }));
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models')).not.toBeNull());
        const nativeModel = getAgentStaticModels('codex')[0]!;
        expect(screen.getTextContent()).toContain(nativeModel.name || nativeModel.id);
        await waitForHomeGovernance(() => expect(screen.findByTestId('agent-models-source-visibility:pc_account')).not.toBeNull());
        const defaultControl = screen.findAllByTestId('provider-model-manager.set-default').find(node => (
            typeof node.props.onPress === 'function' && node.props.accessibilityLabel?.includes('manual-model')
        ));
        expect(defaultControl).toBeDefined();
        await act(async () => { await defaultControl?.props.onPress(); });
        const { storage } = await import('@/sync/domains/state/storage');
        const { ProviderErrorItems } = await import('@/components/settings/providers/ProviderErrorItems');
        const targetKey = 'agent:happier.agent.codex/codex';
        await waitForHomeGovernance(() => expect(screen.findAllByType(ProviderErrorItems).length
            + (storage.getState().settings.providerDefaultModelSelectionsByAgentTargetKeyV1[targetKey] ? 1 : 0)).toBeGreaterThan(0));
        expect(storage.getState().settings.providerDefaultModelSelectionsByAgentTargetKeyV1[targetKey]?.ref).toEqual({
            agentTargetKey: targetKey, providerConnectionId: 'pc_account', modelId: 'manual-model',
        });
        expect(settingsWrites).toBe(1);
        expect(providerHarness.state.requests).toEqual([]);
    });
    it('keeps the addressed Account Agent title when its selected same-Home machine is missing', async () => {
        const { serverId } = await account.restore({ serverIdentityId: 'srv_agent_same_home', machines: [] });
        const agent = { id: 'same-home-agent', name: 'same-home-agent', title: 'Addressed Account Agent title',
            command: 'same-home-agent', createdAt: 1, updatedAt: 1 };
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [agent] });
        account.home.answer(serverId, `GET ${ACP_CATALOG_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: record } },
        });
        const { useAcpCatalogForServer } = await import('@/sync/store/useAcpCatalog');
        const acp = await renderHook(() => useAcpCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(acp.getCurrent().snapshot?.catalog).toMatchObject({ status: 'ready', record }));
        await account.selectMachine(serverId, 'missing-same-home-machine', 'agents');
        const [{ useMachineAdministrationTargetSelection }, { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 }] = await Promise.all([
            import('@/sync/domains/machines/administration/useTargetSelection'),
            import('@/sync/domains/machines/administration/selectionPreferences'),
        ]);
        const selection = await renderHook(() => useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents));
        expect(selection.getCurrent().selectedTarget).toEqual({
            serverIdentityId: 'srv_agent_same_home', machineId: 'missing-same-home-machine',
        });
        expect(selection.getCurrent().state.kind).toBe('missing');
        expect(selection.getCurrent().selectedTargetServerMatchesActiveAccount).toBe(true);
        expect(selection.getCurrent().resolveExecutionTarget()).toBeNull();
        let writes = 0;
        for (const route of ['POST /v2/account/settings', `POST ${ACP_CATALOG_ROWS_ROUTE_V1}`]) {
            account.home.answer(serverId, route, { select: () => {
                writes += 1;
                return { status: 500, body: { error: 'unexpected_write' } };
            } });
        }
        const { AgentModelsScreen } = await import('@/components/settings/agents/AgentModelsScreen');
        const agentTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: agent.id, configuredBackendId: agent.id });
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey={agentTargetKey} runtimeAgentId={null} />);
        expect(screen.findByTestId('settings.agents.models.header')).not.toBeNull();
        expect(screen.getTextContent()).toContain(agent.title);
        expect(writes).toBe(0);
        expect(account.catalogMutations).toEqual([]);
        expect(providerHarness.state.requests).toEqual([]);
    });
    it.each(['revoked', 'missing'] as const)('does not disclose active Account sources or Agent titles through an inaccessible foreign Agent Home (%s)', async state => {
        const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_private_active', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Private active Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
            manualModelsByConnectionId: { pc_private_active: [{ id: 'private-active-model', addedAt: 1 }] },
        });
        const { serverId } = await account.restore({ catalog, serverIdentityId: 'srv_agent_active', machines: [] });
        const { useProviderCatalogForServer } = await import('@/sync/store/useProviderCatalog');
        const admitted = await renderHook(() => useProviderCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(admitted.getCurrent()).toMatchObject({ status: 'ready', revision: 1 }));
        const privateAgent = { id: 'private-active-agent', name: 'private-active-agent',
            title: 'Private active Account Agent title', command: 'private-agent', createdAt: 1, updatedAt: 1 };
        const acpRecord = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: [privateAgent] });
        account.home.answer(serverId, `GET ${ACP_CATALOG_ROWS_ROUTE_V1}`, {
            body: { status: 'present', revision: 1, content: { t: 'plain', v: acpRecord } },
        });
        const { useAcpCatalogForServer } = await import('@/sync/store/useAcpCatalog');
        const acp = await renderHook(() => useAcpCatalogForServer(serverId));
        await waitForHomeGovernance(() => expect(acp.getCurrent().snapshot?.catalog).toMatchObject({
            status: 'ready', record: acpRecord,
        }));
        const peerId = await account.addHome({ name: 'Foreign Agent Home', serverUrl: 'https://foreign-agent-home.test',
            accountId: 'peer-account', serverIdentityId: 'srv_agent_foreign', active: false });
        const peerMachine = createMachineFixture({ id: 'peer-machine', active: true, activeAt: Date.now() });
        if (state === 'revoked') await account.publishMachines(peerId, [peerMachine]);
        await account.selectMachine(peerId, peerMachine.id, 'agents');
        if (state === 'revoked') await account.publishMachines(peerId, [{ ...peerMachine, seq: peerMachine.seq + 1,
            updatedAt: peerMachine.activeAt + 1, metadataVersion: peerMachine.metadataVersion + 1,
            daemonStateVersion: peerMachine.daemonStateVersion + 1, revokedAt: Date.now() }]);
        const [{ useMachineAdministrationTargetSelection }, { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 }] = await Promise.all([
            import('@/sync/domains/machines/administration/useTargetSelection'),
            import('@/sync/domains/machines/administration/selectionPreferences'),
        ]);
        const selection = await renderHook(() => useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.agents));
        expect(selection.getCurrent().selectedTarget).toEqual({ serverIdentityId: 'srv_agent_foreign', machineId: peerMachine.id });
        expect(['offline', 'locked', 'missing', 'replaced', 'revoked']).toContain(selection.getCurrent().state.kind);
        expect(selection.getCurrent().selectedTargetServerMatchesActiveAccount).toBe(false);
        expect(selection.getCurrent().resolveExecutionTarget()).toBeNull();
        let settingsWrites = 0;
        let acpWrites = 0;
        for (const homeId of [serverId, peerId]) {
            account.home.answer(homeId, 'POST /v2/account/settings', { select: () => {
                settingsWrites += 1;
                return { status: 500, body: { error: 'unexpected_settings_write' } };
            } });
            account.home.answer(homeId, `POST ${ACP_CATALOG_ROWS_ROUTE_V1}`, { select: () => {
                acpWrites += 1;
                return { status: 500, body: { error: 'unexpected_acp_write' } };
            } });
        }
        const { AgentModelsScreen } = await import('@/components/settings/agents/AgentModelsScreen');
        const agentTargetKey = resolveBackendTargetKeyV2({ kind: 'backend', backendId: privateAgent.id, configuredBackendId: privateAgent.id });
        const screen = await renderScreen(<AgentModelsScreen agentTargetKey={agentTargetKey} runtimeAgentId={null} />);
        expect(screen.findByTestId('settings.agents.models.header')).not.toBeNull();
        expect(screen.findByTestId('agent-models')).toBeNull();
        expect(screen.findByTestId('agent-models-source-visibility:pc_private_active')).toBeNull();
        expect(screen.getTextContent()).not.toContain('private-active-model');
        expect(screen.getTextContent()).not.toContain(privateAgent.title);
        expect(account.catalogMutations).toEqual([]);
        expect(settingsWrites).toBe(0);
        expect(acpWrites).toBe(0);
        expect(account.readCatalogRow()).toMatchObject({ revision: 1, content: { t: 'plain', v: catalog } });
        expect(providerHarness.state.requests).toEqual([]);
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
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('creates, edits, adds manual models, reloads and deletes through the Account catalog', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse(DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1);
        let revision = 1;
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
        expect(catalog.manualModelsByConnectionId.pc_account).toMatchObject([{ id: 'added-model' }]);
        await hook.unmount();
        const reopened = await renderHook(() => useProviderConnections({ enabled: true, machineId: null, serverId }));
        await waitForHomeGovernance(() => expect(reopened.getCurrent().data?.connections[0]?.displayName).toBe('Renamed source'));
        const refreshReopened = async () => { await reopened.getCurrent().refresh(); };
        const writer = await renderHook(() => useProviderConnectionMutation({ resolveTarget, serverId, refresh: refreshReopened }));
        await act(async () => {
            expect((await writer.getCurrent().run({ action: 'delete', connectionId: created.id }))?.status).toBe('success');
        });
        expect(catalog.connections).toEqual([]);
        expect(reopened.getCurrent().data?.connections).toEqual([]);
        expect(providerHarness.state.requests).toEqual([]);
    });

    it('reads and edits the Account source while the selected machine is offline', async () => {
        let catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
            connections: [{ v: 1, id: 'pc_account', source: { kind: 'custom', template: customTemplate() },
                role: 'named', displayName: 'Account source', displayNameMode: 'custom',
                revision: 1, createdAt: 1, updatedAt: 1 }],
        });
        let revision = 1;
        const { serverId } = await account.restore({ catalog, serverIdentityId: 'srv_provider_offline',
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
        expect(providerHarness.state.requests).toEqual([]);
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
        expect(providerHarness.state.requests).toEqual([]);
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
        expect(providerHarness.state.requests).toEqual([]);
    });
});
