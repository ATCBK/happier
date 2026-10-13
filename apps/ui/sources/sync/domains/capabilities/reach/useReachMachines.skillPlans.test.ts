import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema, RPC_METHODS } from '@happier-dev/protocol';
import { SkillListItemV1Schema } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

// Network and native boundaries are installed before the real catalog/reach composition loads.
const network = await installSessionOpsNetworkBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storageStore');
const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { useReachMachines } = await import('./useReachProjection');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { loadDaemonMergedProjectionCacheEntry, clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { buildSkillsReach } = await import('@/components/settings/skills/skillsCollectionModel');
const before = storage.getState();
afterEach(async () => { await standardCleanup(); storage.setState(before, true); clearDaemonMergedProjectionCacheForTests(); });
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
            capabilities: { tools: { delivery: 'native_mcp' } } },
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
    const facts = await renderHook(() => ({ reach: useReachMachines(),
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
