import { act } from 'react-test-renderer';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { MachineAgentInventoryItem } from '@happier-dev/protocol/capabilities';
import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { adoptHomeProfile, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
const { applyMcpServerCatalogSnapshot, resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { resetMcpServerCatalogEngineForTests } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { applyPromptLibraryCatalogSnapshot, resetPromptLibraryCatalogSnapshotsForTests } = await import('@/sync/store/settings/promptLibraryCatalogSnapshot');
const { resetPromptLibraryCatalogEngineForTests } = await import('@/sync/engine/settings/promptLibraryCatalogEngine');
const { machineAgentInventoryStore } = await import('@/agents/machineAgents/machineAgentInventoryStore');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { useReachProjection } = await import('./useReachProjection');
const before = storage.getState();
afterEach(async () => { await standardCleanup(); storage.setState(before, true); clearMachineRequestReachabilityForTest();
    resetMcpServerCatalogEngineForTests(); resetMcpServerCatalogSnapshotsForTests();
    resetPromptLibraryCatalogEngineForTests(); resetPromptLibraryCatalogSnapshotsForTests(); network.resetRequests(); });
afterAll(() => network.dispose());
const agent = (agentId: string, installed = true): MachineAgentInventoryItem => ({ agentId, title: agentId, installed,
    version: '1.0', latestVersion: null, update: { supported: false, command: null },
    signIn: { status: 'signedIn', loginSupport: 'login_terminal' }, platform: { supported: true },
    install: { available: true, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] });

it.each(['mcp_server', 'skill'] as const)('%s includes offline machines and Project reach with D33 Agent precedence', async kind => {
    const serverUrl = 'https://reach-projection.test';
    await network.addHome(serverUrl, 'reach-projection-account');
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_reach_projection', canonicalServerUrl: serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: serverUrl }] } });
    if (!home.serverIdentityId) throw new Error('Expected qualified Home');
    await setActiveServerId(home.id);
    const scope = { serverId: home.serverIdentityId, accountId: 'reach-projection-account' };
    const online = createMachineFixture({ id: 'online', active: true, activeAt: Date.now() });
    const offline = createMachineFixture({ id: 'offline', active: false, activeAt: 1 });
    for (const machine of [online, offline]) {
        machine.metadata = { ...machine.metadata!, agentInventory: { checkedAt: 2, installedAgentIds: ['codex', 'gemini'] } };
    }
    storage.setState({ settingsScope: scope, profileScope: scope, machines: { online, offline },
        projectAccountRows: { scope, status: 'ready', coverage: 'complete', workspaceRefs: [
            { id: 'checkout-a', serverId: scope.serverId, machineId: 'online', rootPath: '/repo', projectKey: 'shared-project', createdAtMs: 1 },
        ], relationships: [], organizations: [], revisionsByPhysicalKey: {} },
        machineListByServerId: { [scope.serverId]: [online, offline] }, machineListStatusByServerId: { [scope.serverId]: 'idle' } });
    storage.getState().applyMachines([online, offline], true, { sourceServerId: scope.serverId, sourceAccountId: scope.accountId });
    applyMcpServerCatalogSnapshot(scope, { status: 'ready', authority: 'active', revision: 1, diagnostics: [], catalog: {
        v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio', stdio: { command: 'server', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }],
        bindings: [{ id: 'on', serverId: 'server', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
            { id: 'gemini-off', serverId: 'server', target: { t: 'allMachines' }, agentId: 'gemini', enabled: false, createdAt: 1, updatedAt: 1 }],
    } }, true);
    applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'ready', rows: [{ revision: 1,
        record: { key: 'skill-rules', value: { v: 1, rules: [
            { id: 'project-on', skillId: 'server', target: { t: 'project', projectKey: 'shared-project' }, enabled: true, createdAt: 1, updatedAt: 1 },
            { id: 'gemini-off', skillId: 'server', target: { t: 'allMachines' }, agentId: 'gemini', enabled: false, createdAt: 1, updatedAt: 1 },
        ] } } }], tombstones: [], diagnostics: [] }, rawSettings: {}, sourceSettingsVersion: 1 }, true);
    for (const machine of [offline]) machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id), {
        status: machine.active ? 'ready' : 'offline', lastCheckedAt: 1, items: [agent('claude')],
    });
    const hook = await renderHook((options: { projectKey?: string }) => useReachProjection(kind, 'server', options),
        { initialProps: { projectKey: 'shared-project' } as { projectKey?: string } });
    await act(async () => { await vi.waitFor(() => expect(hook.getCurrent()).toHaveLength(2)); });
    expect(hook.getCurrent().find(row => row.machineId === 'offline')).toMatchObject({ offline: true,
        agents: [{ agentId: 'codex', enabled: true }, { agentId: 'gemini', enabled: false }] });
    expect(hook.getCurrent().find(row => row.machineId === 'online')?.offline).toBe(false);
    await act(async () => { recordMachineRequestFailed({ ...scope, machineId: 'online' }); });
    expect(hook.getCurrent().find(row => row.machineId === 'online')?.offline).toBe(true);
    expect(network.requests).toEqual([]);
    if (kind === 'skill') {
        await hook.rerender({ projectKey: 'other-project' });
        expect(hook.getCurrent().every(row => row.agents.every(agent => !agent.enabled))).toBe(true);
        await hook.rerender({ projectKey: 'shared-project' });
        expect(hook.getCurrent().every(row => row.agents.find(agent => agent.agentId === 'codex')?.enabled)).toBe(true);
        await hook.rerender({});
        const projectRows = hook.getCurrent().filter(row => 'projectKey' in row);
        expect(projectRows).toMatchObject([{ machineId: 'online', projectKey: 'shared-project',
            agents: [{ agentId: 'codex', enabled: true }, { agentId: 'gemini', enabled: false }] }]);
    }
    await act(async () => {
        if (kind === 'mcp_server') applyMcpServerCatalogSnapshot(scope, { status: 'unavailable', reason: 'invalid-stored-content' }, true);
        else applyPromptLibraryCatalogSnapshot(scope, { catalog: { status: 'partial', rows: [], tombstones: [],
            diagnostics: [{ key: 'skill-rules', revision: 1, reason: 'invalid-stored-content' }] }, rawSettings: {}, sourceSettingsVersion: 1 }, true);
    });
    expect(hook.getCurrent()).toEqual([]);
});
