import { afterEach, describe, expect, it, vi } from 'vitest';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createDeferred, renderHook } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { invalidateAccountEncryptionModeCache } from '@/sync/api/account/apiAccountEncryptionMode';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { upsertAndActivateServer } from '@/sync/domains/server/serverRuntime';
import { adoptHomeProfile, setActiveServerId } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { encodeBase64 } from '@/encryption/base64';
import { McpServerCatalogRowMutationV1Schema, type McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE } from '@/dev/testkit/fixtures/pluginProviderDaemonProjection';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';

const projectionRpc = vi.hoisted(() => vi.fn());
// The daemon RPC is the boundary; projection admission, adaptation and the Action remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: projectionRpc,
}));

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
// Native/navigation and network/credential persistence are the substituted
// boundaries. Account context, storage, catalog and Action owners remain real.
installApprovalCommonModuleMocks({ storage: original => original(), reactNavigation: async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock() });
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { useWhereItsOnNames } = await import('@/components/capabilities/where/useWhereItsOnNames');
const { useMcpServerTools } = await import('@/components/settings/mcpServers/tools/useMcpServerTools');
const { describeMcpToolAgents } = await import('@/components/settings/mcpServers/tools/McpServerToolsSection');
const { resolveUiAccountActionFallbackMachineId } = await import('./accountActionDeps');
const initialState = getStorage().getState();
const credentialWrites: Array<NonNullable<Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>>>> = [];
afterEach(async () => {
    retireActiveServerAccountScopeLifetime();
    resetRuntimeFetch();
    invalidateAccountEncryptionModeCache();
    resetServerFeaturesClientForTests();
    getStorage().setState(initialState, true);
    clearDaemonMergedProjectionCacheForTests();
    projectionRpc.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const write of credentialWrites.splice(0).reverse()) await write.rollback();
});

const toolFactsProjection = PluginProjectionV2Schema.parse({
    ...PLUGIN_PROVIDER_DAEMON_PROJECTION_FIXTURE,
    installedPackagesById: { 'acme.mcp-facts': { id: 'acme.mcp-facts', displayName: 'MCP facts', version: '1.0.0',
        enabled: true, source: { kind: 'path', locator: '/plugins/acme.mcp-facts' } } },
    agentsById: {
        'acme.mcp-facts/native': { id: 'acme.mcp-facts/native', identity: { pluginId: 'acme.mcp-facts', localId: 'native' },
            title: 'Native Agent', capabilities: { tools: { delivery: 'native_mcp',
                mcpToolControl: { off: 'hidden', approval: 'native' }, mcpToolLoading: 'on_demand' } } },
        'acme.mcp-facts/host': { id: 'acme.mcp-facts/host', identity: { pluginId: 'acme.mcp-facts', localId: 'host' },
            title: 'Host Agent', capabilities: { tools: { delivery: 'native_extension',
                mcpToolControl: { off: 'blocked', approval: 'host' } } } },
        'acme.mcp-facts/unproven': { id: 'acme.mcp-facts/unproven', identity: { pluginId: 'acme.mcp-facts', localId: 'unproven' },
            title: 'Unproven Agent', capabilities: { tools: { delivery: 'shell_bridge' } } },
        'acme.mcp-facts/no-tools': { id: 'acme.mcp-facts/no-tools', identity: { pluginId: 'acme.mcp-facts', localId: 'no-tools' },
            title: 'Agent without tools', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
        'acme.mcp-facts/undeclared': { id: 'acme.mcp-facts/undeclared', identity: { pluginId: 'acme.mcp-facts', localId: 'undeclared' },
            title: 'Unavailable declaration' },
    },
});

async function prepareToolFactsHome(includeMachine = true, installedAgentIds = Object.keys(toolFactsProjection.agentsById),
    onCatalogRead?: () => void, maintenanceReady?: Promise<void>) {
    const home = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
        homeServerIdentityId: 'srv_mcp_tool_facts', canonicalServerUrl: 'https://mcp-tool-facts.test', revision: 1,
        endpoints: [{ kind: 'https', url: 'https://mcp-tool-facts.test' }] } });
    await setActiveServerId(home.id);
    const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'tool-owner' })), 'base64url')}.signature`;
    const write = await TokenStorage.setCredentialsForServerUrlWithRollback(home.serverUrl, { serverId: home.id }, { token });
    if (!write) throw new Error('Test Home credentials unavailable');
    credentialWrites.push(write);
    const machines = includeMachine ? [createMachineFixture({ id: 'facts-machine', activeAt: Date.now(),
        metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: Date.now(), installedAgentIds } } })] : [];
    getStorage().setState({ machines: Object.fromEntries(machines.map(machine => [machine.id, machine])),
        machineListByServerId: { [home.id]: machines }, machineListStatusByServerId: { [home.id]: 'idle' } });
    if (includeMachine) expect(resolveUiAccountActionFallbackMachineId({ serverId: home.id, accountId: 'tool-owner' })).toBe('facts-machine');
    setRuntimeFetch(async url => {
        const target = new URL(String(url));
        if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
        expect(target.origin).toBe(home.serverUrl);
        if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
        if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
        if (target.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 7 });
        if (target.pathname === '/v1/account/entity-rows/mcp') {
            onCatalogRead?.();
            return Response.json({ status: 'present', revision: 3,
                content: { t: 'plain', v: { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
                    stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [] } } });
        }
        if (target.pathname === '/v1/account/entity-rows/profiles/transfer') {
            await maintenanceReady;
            return Response.json({ status: 'absent' });
        }
        if (target.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
        return Response.json({ error: 'not_found' }, { status: 404 });
    });
    return home;
}

describe('UI MCP per-Agent tool facts', () => {
    it('joins simultaneous mounted tool reads without tying their transport to either observer', async () => {
        let catalogReads = 0;
        const maintenance = createDeferred<void>();
        // Hold optional history cleanup at HTTP so its authority rechecks do not count as foreground reads.
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/host'], () => { catalogReads += 1; }, maintenance.promise);
        getStorage().setState({ settingsScope: { serverId: home.serverIdentityId!, accountId: 'tool-owner' } });
        const projectionStarted = createDeferred<void>();
        const projection = createDeferred<unknown>();
        projectionRpc.mockImplementation(async () => { projectionStarted.resolve(); return projection.promise; });
        const first = await renderHook(() => useMcpServerTools('server', 3, ['acme.mcp-facts/host']));
        const second = await renderHook(() => useMcpServerTools('server', 3, ['acme.mcp-facts/host']));
        try {
            await projectionStarted.promise;
            // Both mounted consumers demand the same admitted revision and Agent membership.
            await vi.waitFor(() => expect(catalogReads).toBe(1));
            await first.unmount();
            projection.resolve({ protocolVersion: 1, projection: toolFactsProjection });
            await vi.waitFor(() => expect(second.getCurrent()).toMatchObject({ status: 'ready', list: {
                serverId: 'server', revision: 3, perAgent: { status: 'ready', agents: [
                    { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host' },
                ] },
            } }));
            const admitted = second.getCurrent().list;
            await second.rerender();
            expect(second.getCurrent().list).toBe(admitted);
            expect(catalogReads).toBe(1);
            second.getCurrent().reload();
            await vi.waitFor(() => expect(catalogReads).toBe(2));
            await vi.waitFor(() => expect(second.getCurrent().list).toBe(admitted));
        } finally {
            maintenance.resolve();
            projection.resolve({ protocolVersion: 1, projection: toolFactsProjection });
            await first.unmount();
            await second.unmount();
        }
    });

    it('refreshes the real tools Action when an installed Agent is first published', async () => {
        const home = await prepareToolFactsHome(true, []);
        getStorage().setState({ settingsScope: { serverId: home.serverIdentityId!, accountId: 'tool-owner' } });
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const tools = await renderHook(({ installedAgentIds }) => useMcpServerTools('server', 3, installedAgentIds),
            { initialProps: { installedAgentIds: [] as readonly string[] } });
        try {
            await vi.waitFor(() => expect(tools.getCurrent().status).toBe('ready'));
            expect(tools.getCurrent().list?.perAgent.agents).toEqual([]);
            getStorage().setState(state => {
                const previous = state.machines['facts-machine']!;
                const machine = { ...previous, metadata: { ...previous.metadata!,
                    agentInventory: { checkedAt: Date.now(), installedAgentIds: ['acme.mcp-facts/host'] } } };
                return { machines: { ...state.machines, [machine.id]: machine },
                    machineListByServerId: { ...state.machineListByServerId, [home.id]: [machine] } };
            });
            await tools.rerender({ installedAgentIds: ['acme.mcp-facts/host'] });
            await vi.waitFor(() => expect(tools.getCurrent().list?.perAgent.agents).toEqual([
                { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host', loading: 'every_turn', tokens: null },
            ]));
        } finally { await tools.unmount(); }
    });

    it('uses the facts Machine catalog names for installed external Agents', async () => {
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/host']);
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const receipt = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        if (!receipt.ok) throw new Error(receipt.errorCode);
        const listed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(receipt.result);
        const input = { agentIds: ['acme.mcp-facts/host'], machines: [], projects: [],
            machineId: listed.perAgent.machineId ?? null, serverId: home.id };
        const names = await renderHook(() => useWhereItsOnNames(input));
        try {
            expect(names.getCurrent().names.agentName('acme.mcp-facts/host')).toBe('Host Agent');
        } finally { await names.unmount(); }
    });

    it('returns installed Account Agent facts from the real Action composition and strict consumer', async () => {
        const home = await prepareToolFactsHome(true, ['acme.mcp-facts/native']);
        const offlineMachine = createMachineFixture({ id: 'offline-machine', active: false, activeAt: 0,
            metadata: { ...createMachineFixture().metadata!, agentInventory: { checkedAt: 1, installedAgentIds: ['acme.mcp-facts/host'] } } });
        getStorage().setState(state => ({ machines: { ...state.machines, [offlineMachine.id]: offlineMachine },
            machineListByServerId: { ...state.machineListByServerId, [home.id]: [...(state.machineListByServerId[home.id] ?? []), offlineMachine] } }));
        projectionRpc.mockResolvedValue({ protocolVersion: 1, projection: toolFactsProjection });
        const receipt = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        if (!receipt.ok) throw new Error(receipt.errorCode);
        const listed = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.tools.list'].parse(receipt.result);
        expect(listed.perAgent.agents).toEqual([
            { agentId: 'acme.mcp-facts/native', off: 'hidden', approval: 'native', loading: 'on_demand', tokens: null },
            { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host', loading: 'every_turn', tokens: null },
        ]);
        expect(describeMcpToolAgents(listed.perAgent, id => toolFactsProjection.agentsById[id]!.title!,
            ['acme.mcp-facts/native', 'acme.mcp-facts/host'])).toEqual({
            onDemand: ['Native Agent'], notApply: [], blocked: ['Host Agent'], hidden: ['Native Agent'],
        });
    });

    it('returns exact admitted daemon facts, including Agents with no proven control', async () => {
        const home = await prepareToolFactsHome();
        projectionRpc.mockImplementation(async request => {
            expect(request).toMatchObject({ method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
                serverId: home.serverIdentityId, accountId: 'tool-owner', machineId: 'facts-machine' });
            return { protocolVersion: 1, projection: toolFactsProjection };
        });
        const result = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: true, result: { perAgent: { status: 'ready', machineId: 'facts-machine', agents: [
            { agentId: 'acme.mcp-facts/native', off: 'hidden', approval: 'native', loading: 'on_demand', tokens: null },
            { agentId: 'acme.mcp-facts/host', off: 'blocked', approval: 'host', loading: 'every_turn', tokens: null },
            { agentId: 'acme.mcp-facts/unproven', off: null, approval: null, loading: 'every_turn', tokens: null },
            { agentId: 'acme.mcp-facts/no-tools', off: null, approval: null, loading: 'every_turn', tokens: null },
        ] } } });
    });

    it.each(['no-machine', 'unsupported', 'foreign-home'] as const)('keeps %s facts unavailable', async reason => {
        const home = await prepareToolFactsHome(reason !== 'no-machine');
        if (reason === 'foreign-home') {
            const foreign = await adoptHomeProfile({ source: 'manual', descriptor: { v: 1,
                homeServerIdentityId: 'srv_foreign_mcp_tool_facts', canonicalServerUrl: 'https://foreign-mcp-tool-facts.test', revision: 1,
                endpoints: [{ kind: 'https', url: 'https://foreign-mcp-tool-facts.test' }] } });
            await setActiveServerId(foreign.id);
        }
        projectionRpc.mockImplementation(async () => {
            if (reason === 'unsupported') throw Object.assign(new Error('Projection not supported'), { code: 'RPC_METHOD_NOT_AVAILABLE' });
            // A mistaken fallback would receive usable facts and wrongly claim readiness.
            return { protocolVersion: 1, projection: toolFactsProjection };
        });
        const result = await createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: true, result: { perAgent: { status: 'unavailable', agents: [] } } });
    });

    it.each(['retired', 'cancelled'] as const)('never discloses projection facts after the invocation is %s', async transition => {
        const home = await prepareToolFactsHome();
        const projectionStarted = createDeferred<void>();
        const response = createDeferred<unknown>();
        projectionRpc.mockImplementation(async request => {
            expect(request.method).toBe(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            projectionStarted.resolve();
            return response.promise;
        });
        const cancellation = new AbortController();
        const execution = createDefaultActionExecutor().execute('mcp.servers.tools.list', { serverId: 'server' },
            { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, signal: cancellation.signal });
        const settled = execution.catch(error => {
            expect(error).toMatchObject({ name: 'AbortError' });
            return { ok: false as const };
        });
        try {
            const phase = await Promise.race([projectionStarted.promise.then(() => 'projection'), settled.then(() => 'settled')]);
            expect(phase).toBe('projection');
            if (transition === 'retired') {
                await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
            }
            else cancellation.abort();
            response.resolve({ protocolVersion: 1, projection: toolFactsProjection });
            // The captured invocation may reject cancellation or return a typed refusal; neither discloses facts.
            const result = await settled;
            expect(result).toMatchObject({ ok: false });
            expect(result).not.toHaveProperty('result');
        } finally {
            response.resolve({ protocolVersion: 1, projection: toolFactsProjection });
            await settled;
        }
    });
});

describe('UI MCP Actions through captured Home persistence', () => {
    it('creates and reads on the requested Home after another Home receives focus', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://mcp-action-home.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://focused-mcp-action-home.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'owner' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const settings = { mcpServersStrictMode: true, actionsSettingsV1: { v: 1,
            approvalWaivedSurfaces: { 'mcp.servers.create': ['ui'] } } };
        let catalog: McpServerCatalogV1 = { v: 1, servers: [], bindings: [] };
        let revision = 1;
        const writes: string[] = [];
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (target.pathname === '/v2/account/settings') {
                expect(init?.method ?? 'GET').toBe('GET');
                return Response.json({ content: { t: 'plain', v: settings }, version: 7 });
            }
            if (target.pathname === '/v1/account/entity-rows/mcp') {
                if (init?.method === 'POST') {
                    const input = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    expect(input.expectedRevision).toBe(revision);
                    if (input.content?.t !== 'plain') throw new Error('Expected plain Account row');
                    catalog = input.content.v;
                    writes.push(target.pathname);
                    return Response.json({ status: 'updated', revision: ++revision, cursor: revision });
                }
                return Response.json({ status: 'present', revision, content: { t: 'plain', v: catalog } });
            }
            if (target.pathname === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
            if (target.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        const context = { serverId: home.id, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
        const entry = { id: 'server', name: 'server', transport: 'stdio', stdio: { command: 'mcp-tool', args: [] },
            env: { TOKEN: { t: 'literal', v: 'private' } }, createdAt: 1, updatedAt: 1 } as const;
        // Native randomness is supplied by the UI platform adapter; Web Crypto is not required.
        vi.stubGlobal('crypto', undefined);
        expect(await executor.execute('mcp.servers.create', { entry, expectedRevision: 1 }, context))
            .toEqual({ ok: true, result: { status: 'updated', revision: 2, cursor: 2 } });
        expect(await executor.execute('mcp.servers.read', { serverId: 'server' }, context)).toMatchObject({ ok: true,
            result: { status: 'present', server: entry, revision: 2, complete: true, authority: 'active' } });
        expect(writes).toEqual(['/v1/account/entity-rows/mcp']);
        expect(catalog.bindings).toMatchObject([{ serverId: 'server', enabled: true, target: { t: 'allMachines' } }]);
    });
    it('lists an admitted catalog without awaiting retained-source maintenance', async () => {
        const home = await upsertAndActivateServer({ serverUrl: 'https://mcp-action-read-home.test', scope: 'tab' });
        await upsertAndActivateServer({ serverUrl: 'https://focused-mcp-action-read-home.test', scope: 'tab' });
        const token = `header.${encodeBase64(new TextEncoder().encode(JSON.stringify({ sub: 'read-owner' })), 'base64url')}.signature`;
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
        const maintenanceStarted = createDeferred<void>();
        const releaseMaintenance = createDeferred<void>();
        let catalogObserved = false;
        // Only captured Home HTTP is substituted. Required Account/approval
        // reads finish; the source GET after the ready row is optional cleanup.
        setRuntimeFetch(async (url, init) => {
            const target = new URL(String(url));
            if (target.pathname === '/health' || target.pathname === '/v1/auth/ping') return Response.json({});
            expect(target.origin).toBe(home.serverUrl);
            if (target.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (target.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (target.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: 7 }));
            if (target.pathname === '/v2/account/settings') {
                expect(init?.method ?? 'GET').toBe('GET');
                if (catalogObserved) {
                    maintenanceStarted.resolve();
                    await releaseMaintenance.promise;
                }
                return Response.json({ content: { t: 'plain', v: { mcpServersStrictMode: true } }, version: 7 });
            }
            if (target.pathname === '/v1/account/entity-rows/mcp') {
                expect(init?.method ?? 'GET').toBe('GET');
                catalogObserved = true;
                return Response.json({ status: 'present', revision: 3, content: { t: 'plain', v: {
                    v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio',
                        stdio: { command: 'mcp-tool', args: [] }, env: {}, createdAt: 1, updatedAt: 1 }], bindings: [],
                } } });
            }
            if (target.pathname === '/v1/account/entity-rows/profiles/transfer') return Response.json({ status: 'absent' });
            if (target.pathname === '/v2/account/settings/history') return Response.json({ snapshots: [] });
            return Response.json({ error: 'not_found' }, { status: 404 });
        });
        const executor = createDefaultActionExecutor();
        let settled = false;
        const list = executor.execute('mcp.servers.list', {}, { serverId: home.id, surface: 'ui',
            authority: 'present_user', actionCaller: { kind: 'host' } }).then(result => { settled = true; return result; });
        try {
            const phase = await Promise.race([list.then(() => 'read' as const), maintenanceStarted.promise.then(() => 'maintenance' as const)]);
            // Cleanup may already be running, but its deferred response must
            // not postpone the finite read or imply cleanup has completed.
            if (phase === 'maintenance') await vi.waitFor(() => expect(settled).toBe(true));
            const result = await list;
            expect(result).toMatchObject({ ok: true, result: { status: 'ready', authority: 'active', revision: 3,
                catalog: { v: 1, servers: [{ id: 'server', name: 'server', transport: 'stdio', createdAt: 1, updatedAt: 1 }], bindings: [] } } });
            expect(result).not.toMatchObject({ result: { cleanup: { status: 'complete' } } });
        } finally {
            releaseMaintenance.resolve();
            await list;
        }
    });
});
