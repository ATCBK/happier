import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema, RPC_METHODS } from '@happier-dev/protocol';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { MachineAgentInventoryItemSchema } from '@happier-dev/protocol/capabilities';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

// Network and native boundaries are installed before the real catalog/reach composition loads.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { useReachMachines, projectReachOnMachines } = await import('./useReachProjection');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { loadDaemonMergedProjectionCacheEntry, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { buildSkillsReach, skillPlanOnMachine } = await import('@/components/settings/skills/skillsCollectionModel');
const { useAgentCatalogIdentities } = await import('@/agents/registry/useSessionAgentCatalogIdentity');
const { useWhereItsOnNames } = await import('@/components/capabilities/where/useWhereItsOnNames');
const { useSkillPlaces } = await import('@/components/settings/skills/useSkillPlaces');
const { applyAcpCatalogSnapshot, resetAcpCatalogSnapshotsForTests } = await import('@/sync/store/settings/acpCatalogSnapshot');
const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { WhereItsOnControl } = await import('@/components/capabilities/where/WhereItsOnControl');
const { describeReach } = await import('@/components/capabilities/where/whereItsOnPresentation');
const before = storage.getState();
afterEach(async () => { await standardCleanup(); storage.setState(before, true); clearDaemonMergedProjectionCacheForTests();
    resetAcpCatalogSnapshotsForTests(); network.resetRequests(); });
afterAll(() => network.dispose());

it('composes installed Machine publication and real catalog demand into passive skill-plan reach', async () => {
    const serverUrl = 'https://skill-plans-reach.test';
    await network.addHome(serverUrl, 'skill-plans-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_skill_plans', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: home.serverIdentityId, accountId: 'skill-plans-account' };
    const machine = createMachineFixture({ id: 'online', activeAt: Date.now(), metadata: {
        ...createMachineFixture().metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['codex', 'gemini'] },
    } });
    storage.setState({ settingsScope: scope, profileScope: scope, machines: { online: machine },
        machineListByServerId: { [scope.serverId]: [machine] }, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    const projection = PluginProjectionV2Schema.parse({ ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE, agentsById: {
        codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
            capabilities: { tools: { delivery: 'native_mcp' }, skills: { delivery: 'session_dir', nativeDisable: 'unsupported', liveReload: 'unsupported' } } },
        gemini: { id: 'gemini', identity: { pluginId: 'happier.agent.gemini', localId: 'gemini' },
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
    } });
    network.respond(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE, { protocolVersion: 1, projection });
    network.setHttpResponder(async url => {
        const pathname = new URL(String(url)).pathname;
        if (pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        return null;
    });
    const facts = await renderHook(() => ({ reach: useReachMachines(), skillPlaces: useSkillPlaces(),
        credentials: useServerCredentialAccountScopeBinding(scope.serverId) }));
    try {
        await vi.waitFor(() => expect(facts.getCurrent().credentials.binding).not.toBeNull());
        expect(network.requests).toEqual([]);
        await act(async () => {
            const entry = await loadDaemonMergedProjectionCacheEntry({ machineId: 'online', serverId: scope.serverId,
                accountLifetime: facts.getCurrent().credentials.binding! });
            expect(entry).toMatchObject({ kind: 'ready' });
        });
        const machines = facts.getCurrent().reach.machines;
        expect(machines[0]?.agentDeclarationsById).toEqual(projection.agentsById);
        expect(skillPlanOnMachine(machines[0]!, 'codex')).toBe('session_dir');
        expect(facts.getCurrent().skillPlaces.agentTakes('codex')).toBe('full');
        const item = SkillListItemV1Schema.parse({ skillId: 'reaching', name: 'reaching', description: null,
            revision: '1:1', rules: [{ id: 'on', skillId: 'reaching', target: { t: 'allMachines' },
                enabled: true, createdAt: 1, updatedAt: 1 }], trust: 'text_only', cost: { descriptionTokens: 1, bodyTokens: 2 },
            provenance: { kind: 'written' }, modified: false, updatePolicy: 'manual', createdAt: 1,
            migratedFromContext: false, userInvocable: true, folderId: null });
        expect(buildSkillsReach([item], machines).agentIds).toEqual(['codex']);
        const requests = network.requests.length;
        await facts.rerender();
        expect(network.requests).toHaveLength(requests);
    } finally { await facts.unmount(); }
});

it('composes concrete ACP inventory and the Account catalog into distinct configured names without naming a bare carrier', async () => {
    const serverUrl = 'https://configured-reach-identity.test';
    await network.addHome(serverUrl, 'configured-identity-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_configured_reach_identity', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    await setActiveServerId(home.id);
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    const scope = { serverId: home.serverIdentityId, accountId: 'configured-identity-account' };
    const machine = createMachineFixture({ id: 'configured-machine', activeAt: Date.now(), metadata: {
        ...createMachineFixture().metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['codex', 'custom-acp'] },
    } });
    storage.setState({ settingsScope: scope, profileScope: scope, machines: { [machine.id]: machine },
        machineListByServerId: { [scope.serverId]: [machine] }, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: ['review', 'build', 'absent'].map(id => ({
        id, name: id, title: `${id} configured agent`, launch: { kind: 'npm', package: 'fixture', version: '1.0', args: [] },
        env: {}, createdAt: 1, updatedAt: 1,
    })) });
    applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record }, true);
    const agentIds = ['custom-acp'];
    const places = [{ machineId: machine.id, name: 'Build machine' }];
    const hook = await renderHook(() => ({
        reach: useReachMachines(),
        identities: useAgentCatalogIdentities({ agentIds, machineId: machine.id, serverId: scope.serverId }),
        names: useWhereItsOnNames({ agentIds, machines: places, projects: [], serverId: scope.serverId }),
        skillPlaces: useSkillPlaces(),
    }));
    try {
        expect(hook.getCurrent().reach.machines[0]?.agentIds).toEqual(['codex']);
        expect(hook.getCurrent().reach.machines[0]?.agentInventoryComplete).toBe(false);
        expect(hook.getCurrent().identities).toEqual([]);
        const rule = { id: 'on', skillId: 'skill', target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1 };
        const knownProjection = projectReachOnMachines([rule], hook.getCurrent().reach.machines);
        expect(knownProjection[0]?.agentInventoryComplete).toBe(false);
        const places = hook.getCurrent().skillPlaces;
        expect(describeReach(knownProjection, places.placeMachines, places.names, places.agentTakes).availabilityUnknown).toBe(false);
        const emptyProjection = projectReachOnMachines([{ ...rule, enabled: false }], hook.getCurrent().reach.machines);
        expect(describeReach(emptyProjection, places.placeMachines, places.names, places.agentTakes).availabilityUnknown).toBe(true);
        await act(async () => {
            machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), {
                status: 'ready', lastCheckedAt: 3, items: record.definitions.map(definition => MachineAgentInventoryItemSchema.parse({
                    agentId: 'custom-acp', definitionId: definition.id, title: 'Outdated inventory name', installed: definition.id !== 'absent',
                    version: '1', latestVersion: null, update: { supported: false, command: null },
                    signIn: { status: 'unknown', loginSupport: 'unsupported', required: false }, platform: { supported: true },
                    install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [],
                })),
            });
        });
        expect(hook.getCurrent().reach.machines[0]?.agentIds).toEqual(['codex', 'custom-acp']);
        expect(hook.getCurrent().reach.machines[0]?.agentInventoryComplete).toBe(true);
        expect(hook.getCurrent().identities.map(identity => [identity.entry.title, identity.entry.backendTargetKey, identity.entry.iconName]))
            .toEqual([
                ['review configured agent', 'agent:happier.agent.custom-acp/custom-acp:definition:review', 'hard-drives'],
                ['build configured agent', 'agent:happier.agent.custom-acp/custom-acp:definition:build', 'hard-drives'],
            ]);
        const name = hook.getCurrent().names.names.agentName('custom-acp');
        expect(name).toContain('review configured agent');
        expect(name).toContain('build configured agent');
        expect(name).not.toContain('absent configured agent');
        expect(hook.getCurrent().names.identityById.get('custom-acp')).toBeUndefined();
        expect(hook.getCurrent().names.identityById.get('agent:happier.agent.custom-acp/custom-acp:definition:review')?.entry.title)
            .toBe('review configured agent');
        expect(hook.getCurrent().names.identityById.get('agent:happier.agent.custom-acp/custom-acp:definition:build')?.entry.title)
            .toBe('build configured agent');
        expect(network.requests).toEqual([]);
        function ConfiguredWhere() {
            const skillPlaces = useSkillPlaces();
            return React.createElement(WhereItsOnControl, {
                kind: 'skill', rules: [rule], status: 'ready',
                projection: projectReachOnMachines([rule], skillPlaces.machines),
                places: { agentIds: skillPlaces.agentIds, machines: skillPlaces.placeMachines, projects: [] },
                agentTakes: skillPlaces.agentTakes,
                onChange: async () => ({ ok: true as const }), presentation: 'pick', testID: 'configured-where',
            });
        }
        const screen = await renderScreen(React.createElement(ConfiguredWhere));
        const directText = (children: unknown): string => typeof children === 'string' ? children
            : Array.isArray(children) ? children.map(directText).join('') : '';
        const renderedText = () => screen.findAll(() => true).map(node => directText(node.props.children)).join(' ');
        expect(renderedText()).toContain('review configured agent');
        expect(renderedText()).toContain('build configured agent');
        expect(renderedText()).not.toContain('absent configured agent');
        expect(screen.findAll(node => node.props.name === 'hard-drives')).not.toHaveLength(0);
        await act(async () => applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 2, record: { v: 1, definitions: [] } }, true));
        expect(hook.getCurrent().identities).toEqual([]);
        expect(hook.getCurrent().reach.machines[0]?.agentIds).toEqual(['codex']);
        expect(hook.getCurrent().reach.machines[0]?.agentInventoryComplete).toBe(true);
        expect(renderedText()).not.toContain('review configured agent');
        expect(renderedText()).not.toContain('build configured agent');
    } finally { await hook.unmount(); }
});
