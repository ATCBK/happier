import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import type { MachineAgentInventoryItem, PluginProjectionV2 } from '@happier-dev/protocol';
import { FeaturesResponseSchema, PluginProjectionV2Schema } from '@happier-dev/protocol';
import { AcpCatalogRecordV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { isMachineAgentReady } from './resolveMachineAgentState';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// Install physical HTTP/Socket.IO before loading the real scoped-RPC owner.
const network = await installSessionOpsNetworkBoundary();
// This responder supplies daemon ACK bodies; it never replaces internal RPC logic.
const rpc = vi.fn();
const { storage } = await import('@/sync/domains/state/storageStore');
const { serverAccountScopedResourceKey } = await import('@/sync/domains/scope/serverAccountScope');
const { EMPTY_MACHINE_AGENTS, machineAgentInventoryStore } = await import('./machineAgentInventoryStore');
const { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { installConnectedAccountDescriptorProjection, retireConnectedAccountDescriptorProjection } = await import('@/sync/domains/connectedServices/connectedServiceRegistry');
const { loadDaemonMergedProjectionInputs } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { publishMachineContributionRegistryProjectionInvalidation } = await import('@/sync/ops/machineContributionRegistryProjectionRevision');
const { refreshMachineAgents, useMachineAgents, useMachineAgentsByMachine } = await import('./useMachineAgents');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { clearMachineRequestReachabilityForTest, recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
const { applyAcpCatalogSnapshot } = await import('@/sync/store/settings/acpCatalogSnapshot');

const item: MachineAgentInventoryItem = { agentId: 'review', title: 'Review', installed: true, version: '1', latestVersion: '1', update: { supported: false, command: null }, signIn: { status: 'signedIn', loginSupport: 'status_only' }, platform: { supported: true }, install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: null }, dependencies: [] };
const emptyProjection: PluginProjectionV2 = { v: 2, generation: 1, installedPackagesById: {}, agentsById: {}, actionsById: {}, familiesById: {}, toolsById: {}, commandsById: {}, resourcesById: {}, settingsById: {}, diagnostics: [] };

beforeEach(() => {
    network.resetRequests();
    network.setHttpResponder(async (input) => new URL(String(input)).pathname === '/v1/account/encryption'
        ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
    network.setRpcAckResponder(async (request) => ({ ok: true, result: await rpc({
        method: request.method, payload: request.payload,
    }) }));
});
afterEach(async () => {
    standardCleanup();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    rpc.mockReset();
    clearMachineRequestReachabilityForTest();
    storage.setState(storage.getInitialState(), true);
});
afterAll(() => network.dispose());

describe('machine inventory lifecycle boundary', () => {
    it('detects caller catalog definitions separately and clears them only for a ready-empty catalog', async () => {
        const server = await network.addHome('https://definition-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'definition-inventory-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const record = AcpCatalogRecordV1Schema.parse({ v: 1, definitions: ['first', 'second'].map(id => ({
            id, name: id, title: `Caller ${id}`, launch: { kind: 'npm', package: 'fixture', version: '1.0', args: [] },
            env: { TOKEN: { t: 'literal', v: 'never-sent-secret' } }, createdAt: 1, updatedAt: 1,
        })) });
        applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 1, record }, true);
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload?: { requests?: { id: string; params?: { definitions?: { definitionId: string; title: string }[] } }[] } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection: emptyProjection };
            if (method === 'capabilities.detect') {
                expect(JSON.stringify(payload)).not.toContain('never-sent-secret');
                const definitions = payload?.requests?.find(request => request.id === 'tool.acpAgentInventory')?.params?.definitions ?? [];
                return { protocolVersion: 1, results: { 'tool.acpAgentInventory': { ok: true, checkedAt: 24, data: {
                    items: definitions.map(definition => ({ ...item, agentId: 'custom-acp', definitionId: definition.definitionId, title: definition.title,
                        managed: true, fit: { kind: 'can_run', via: 'npm' }, version: definition.definitionId === 'first' ? '1.0' : '2.0' })),
                } } } };
            }
            return { jobs: [] };
        });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        expect(machineAgentInventoryStore.read(key).agents.map(agent => [agent.definitionId, agent.version])).toEqual([['first', '1.0'], ['second', '2.0']]);
        const hook = await renderHook(() => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false }));
        try {
            await act(async () => applyAcpCatalogSnapshot(scope, { status: 'unavailable', reason: 'unreachable' }, true));
            expect(hook.getCurrent().agents).toMatchObject([{ definitionId: 'first', stale: true }, { definitionId: 'second', stale: true }]);
            await act(async () => applyAcpCatalogSnapshot(scope, { status: 'ready', revision: 2, record: { v: 1, definitions: [] } }, true));
            expect(hook.getCurrent().agents).toEqual([]);
        } finally { await hook.unmount(); }
    });
    it('allows explicit refresh after an exact Account request failed while passive refresh remains offline', async () => {
        const server = await network.addHome('https://explicit-agent-retry.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'explicit-agent-retry-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        rpc.mockResolvedValue({ protocolVersion: 1, projection: emptyProjection });
        recordMachineRequestFailed({ ...scope, machineId: machine.id });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime });
        expect(machineAgentInventoryStore.read(key).status).toBe('offline');
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime, force: true });
        expect(machineAgentInventoryStore.read(key).status).toBe('ready');
    });
    it('retains locked machine inventory without requesting executable Agent facts', async () => {
        const server = await network.addHome('https://locked-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'locked-inventory-machine', active: true, activeAt: Date.now(),
            availability: { kind: 'locked', reason: 'encryption_material_unavailable' } });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        machineAgentInventoryStore.publish(key, { status: 'ready', items: [item], lastCheckedAt: 12 });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime, force: true });
        expect(machineAgentInventoryStore.read(key)).toMatchObject({ status: 'offline', lastCheckedAt: 12 });
        expect(rpc).not.toHaveBeenCalled();
    });
    it.each(['detail', 'summary'] as const)('denies cached Agent readiness on exact-Home request failure and restores on success (%s)', async mode => {
        const server = await network.addHome(`https://inventory-reachability-${mode}.example.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: `reachability-${mode}-machine`, active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: 12, data: item } } };
            return { jobs: [] };
        });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const hook = await renderHook(mode === 'detail'
            ? () => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false })
            : () => useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }).get(machine.id) ?? EMPTY_MACHINE_AGENTS);
        try {
            expect(hook.getCurrent().status).toBe('ready');
            await act(async () => recordMachineRequestFailed({ serverId: 'other-home', accountId: scope.accountId, machineId: machine.id }));
            expect(isMachineAgentReady(hook.getCurrent().agents[0])).toBe(true);
            await act(async () => recordMachineRequestFailed({ ...scope, machineId: machine.id }));
            expect(hook.getCurrent()).toMatchObject({ status: 'offline', lastCheckedAt: 12 });
            expect(isMachineAgentReady(hook.getCurrent().agents[0])).toBe(false);
            await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
            expect(hook.getCurrent().status).toBe('offline');
            await act(async () => refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime, force: true }));
            expect(hook.getCurrent().status).toBe('ready');
            expect(isMachineAgentReady(hook.getCurrent().agents[0])).toBe(true);
        } finally { await hook.unmount(); }
    });
    it('keeps passive summary snapshots stable without a getSnapshot warning', async () => {
        const { useUpdatesSummary } = await import('@/updates/useUpdatesSummary');
        const server = await network.addHome('https://stable-summary-inventory.example.test', 'inventory-account');
        const machine = createMachineFixture({ id: 'stable-summary-machine', active: false, activeAt: 0 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: { serverId: server.id, accountId: 'inventory-account' } });
        const errors = vi.spyOn(console, 'error');
        const hook = await renderHook(() => ({
            inventory: useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }),
            updates: useUpdatesSummary(),
        }));
        try {
            await vi.waitFor(() => expect(hook.getCurrent().inventory.get(machine.id)?.status).toBe('offline'));
            const snapshot = hook.getCurrent();
            await hook.rerender();
            expect(hook.getCurrent().inventory).toBe(snapshot.inventory);
            expect(hook.getCurrent().updates).toBe(snapshot.updates);
            expect(errors.mock.calls.filter(args => args.some(value => String(value).includes('getSnapshot should be cached')))).toEqual([]);
        } finally { await hook.unmount(); errors.mockRestore(); }
    });

    it('loads selected Agent readiness without waiting for vendor updates and expands the same inventory when the picker opens', async () => {
        const server = await network.addHome('https://selected-agent-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: 'selected-agent-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: Object.fromEntries(['review', 'other'].map(id => [id, {
            id, title: id, capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        }])) });
        const probed = new Set<string>();
        const vendorUpdates = createDeferred<void>();
        rpc.mockImplementation(async ({ method, payload }: { method: string; payload?: { requests?: { id: string; params?: { includeLoginStatus?: boolean; includeLatestVersion?: boolean } }[] } }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            // The vendor release registry is a network boundary. The daemon
            // awaits it only when latest-version information is requested.
            if (method === 'capabilities.detect' && payload?.requests?.some(request => request.params?.includeLatestVersion)) {
                await vendorUpdates.promise;
            }
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: Object.fromEntries((payload?.requests ?? []).map(({ id, params }) => {
                probed.add(id);
                // Mirrors cliSnapshot.ts: a login-status request also returns isLoggedIn/authStatus.
                const loginStatus = params?.includeLoginStatus ? { isLoggedIn: true, authStatus: { state: 'logged_in' as const, checkedAt: 12 } } : {};
                return [id, { ok: true, checkedAt: 12, data: { ...item, latestVersion: params?.includeLatestVersion ? item.latestVersion : null, agentId: id.slice(4), ...loginStatus } }];
            })) };
            return { jobs: [] };
        });
        const initialProps: { agentId?: string } = { agentId: 'review' };
        const hook = await renderHook(({ agentId }: { agentId?: string }) => useMachineAgents({ serverId: server.id, machineId: machine.id, agentId }),
            { initialProps });
        try {
            await vi.waitFor(() => expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'review'))).toBe(true));
            expect(hook.getCurrent().agents.find(agent => agent.agentId === 'review')?.latestVersion).toBeNull();
            expect(probed).toEqual(new Set(['cli.review']));
            expect(network.requests.filter(({ method }) => method === 'capabilities.detect')).toEqual([
                expect.objectContaining({ serverUrl: server.serverUrl, token: server.token, targetId: machine.id }),
            ]);
            await hook.rerender({});
            vendorUpdates.resolve();
            await vi.waitFor(() => expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'other'))).toBe(true));
            expect(isMachineAgentReady(hook.getCurrent().agents.find(agent => agent.agentId === 'review'))).toBe(true);
            await vi.waitFor(() => expect(hook.getCurrent().agents.find(agent => agent.agentId === 'review')?.latestVersion).toBe('1'));
        } finally { vendorUpdates.resolve(); await hook.unmount(); }
    });

    it('does not replace current Agent facts with a detect response from an invalidated registry', async () => {
        const server = await network.addHome('https://inventory-inflight.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'inflight-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        const oldDetect = createDeferred<unknown>();
        let detected = false;
        let first = true;
        const answer = (installed: boolean) => ({ protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: installed ? 12 : 24, data: { ...item, installed } } } });
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') {
                if (first) { first = false; detected = true; return await oldDetect.promise; }
                return answer(false);
            }
            return { jobs: [] };
        });
        const previous = refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        await vi.waitFor(() => expect(detected).toBe(true));
        publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machine.id });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        expect(machineAgentInventoryStore.read(key)).toMatchObject({ lastCheckedAt: 24, agents: [{ state: 'notInstalled' }] });
        oldDetect.resolve(answer(true));
        await previous;
        expect(machineAgentInventoryStore.read(key)).toMatchObject({ lastCheckedAt: 24, agents: [{ state: 'notInstalled' }] });
    });

    it.each(['detail', 'summary'] as const)('retains ready Agent facts across unrelated daemon publications and refreshes on registry invalidation (%s)', async (mode) => {
        const server = await network.addHome(`https://inventory-freshness-${mode}.example.test`, 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: `freshness-${mode}-machine`, active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Review', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        let installed = true;
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) return { protocolVersion: 1, projection };
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: 12, data: { ...item, installed } } } };
            return { jobs: [] };
        });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        expect(isMachineAgentReady(machineAgentInventoryStore.read(key).agents[0])).toBe(true);
        const readInventory = mode === 'detail'
            ? () => useMachineAgents({ serverId: server.id, machineId: machine.id })
            : () => useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: true }).get(machine.id) ?? EMPTY_MACHINE_AGENTS;
        const hook = await renderHook(readInventory);
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        const readyAgent = hook.getCurrent().agents[0];
        rpc.mockClear();
        await act(async () => storage.setState({ machineListByServerId: { [server.id]: [{ ...machine, daemonStateVersion: 2 }] } }));
        await vi.waitFor(() => expect(hook.getCurrent().status).toBe('ready'));
        expect(hook.getCurrent().agents[0]).toBe(readyAgent);
        expect(rpc.mock.calls.filter(([request]) => request.method === 'capabilities.detect')).toHaveLength(0);
        installed = false;
        await act(async () => publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machine.id }));
        await vi.waitFor(() => expect(hook.getCurrent().agents[0]?.state).toBe('notInstalled'));
        await hook.unmount();
    });

    it('retains descriptors and last-good facts but denies readiness when a projection refresh fails', async () => {
        const server = await network.addHome('https://inventory-projection-failure.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const lifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'failed-projection-machine', active: true, activeAt: Date.now() });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const projection = PluginProjectionV2Schema.parse({ ...emptyProjection, agentsById: { review: {
            id: 'review', title: 'Current review descriptor', capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
        } } });
        let failed = false;
        rpc.mockImplementation(async ({ method }: { method: string }) => {
            if (method.includes('contributionRegistryProjection.describe')) {
                if (failed) throw new Error('transport disconnected');
                return { protocolVersion: 1, projection };
            }
            if (method === 'capabilities.detect') return { protocolVersion: 1, results: { 'cli.review': { ok: true, checkedAt: 12, data: item } } };
            return { jobs: [] };
        });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        failed = true;
        publishMachineContributionRegistryProjectionInvalidation({ serverId: server.id, machineId: machine.id });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: lifetime });
        const hook = await renderHook(() => useMachineAgents({ serverId: server.id, machineId: machine.id, load: false }));
        await vi.waitFor(() => expect(hook.getCurrent()).toMatchObject({ status: 'error', lastCheckedAt: 12,
            agents: [{ title: 'Current review descriptor', installed: true, stale: true }] }));
        expect(isMachineAgentReady(hook.getCurrent().agents[0])).toBe(false);
        await hook.unmount();
    });

    it('uses each Machine’s own authentication modes and keeps unanswered or internally conflicted Machines unknown', async () => {
        const server = await network.addHome('https://passive-auth-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const accountLifetime = { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
        const machine = createMachineFixture({ id: 'passive-auth-machine', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        const otherMachine = { ...machine, id: 'older-auth-machine' };
        const unansweredMachine = { ...machine, id: 'unanswered-auth-machine' };
        const conflictedMachine = { ...machine, id: 'conflicted-auth-machine' };
        const service = { pluginId: 'acme.review', localId: 'account' };
        storage.setState({ machineListByServerId: { [server.id]: [machine, otherMachine, unansweredMachine, conflictedMachine] }, profileScope: scope, profile: {
            ...storage.getState().profile,
            connectedAccountsV4: [{ ref: { service, accountId: 'work' }, revisionSemantics: 'revisioned', credentialRevision: 'revision-1',
                status: 'connected', kind: 'oauth', authenticationModeId: 'oauth', configurationReady: true, configurationRevision: null,
                displayName: 'Work account', scopes: [] }],
        } });
        const descriptor = {
            id: 'account', serviceId: 'account', pluginId: service.pluginId, title: 'Review account', provenance: 'external', sourceKind: 'installed',
            authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', callbackUrl: 'http://127.0.0.1:4000/auth/callback', pkce: 'required', outcomeReconciliation: 'providerCheck' }] },
            capabilities: [], availability: { state: 'available', reason: 'resolved' }, diagnostics: [],
        } satisfies NonNullable<PluginProjectionV2['familiesById']['connectedAccounts']>['entriesById'][string];
        const otherDescriptor = { ...descriptor, authentication: { defaultModeId: 'older-oauth',
            modes: [{ ...descriptor.authentication.modes[0], id: 'older-oauth' }] } };
        const { mergeConnectedAccountDescriptorProjections } = await import('@/sync/domains/connectedServices/connectedAccountDescriptorProjection');
        const { getConnectedServiceRegistrySnapshot } = await import('@/sync/domains/connectedServices/connectedServiceRegistry');
        const accountUnion = mergeConnectedAccountDescriptorProjections([
            { kind: 'ready', descriptors: [descriptor] }, { kind: 'ready', descriptors: [otherDescriptor] },
        ]);
        expect(accountUnion.kind).toBe('conflict');
        if (accountUnion.kind === 'error') throw new Error('Expected answering Machines');
        installConnectedAccountDescriptorProjection({ scopeKey: server.id, status: accountUnion.kind, conflicts: accountUnion.conflicts,
            errorReason: null, descriptors: accountUnion.descriptors }, accountLifetime);
        primeServerFeaturesSnapshot({ serverId: server.id, snapshot: { status: 'ready', features: FeaturesResponseSchema.parse({
            features: {}, capabilities: { connectedServices: { qualifiedAccounts: { protocolVersion: 4 } } },
        }) } });
        const projection = PluginProjectionV2Schema.parse({
            ...emptyProjection,
            familiesById: { connectedAccounts: { family: 'connectedAccounts', entriesById: { 'acme.review/account': descriptor } } },
            agentsById: {
                review: {
                    id: 'review', title: 'Review', connectedAccounts: [{ purpose: 'primary', service, credentialKinds: ['oauth'] }],
                    capabilities: { surfaces: [], sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
                },
            },
        });
        for (const [target, descriptors] of [
            // Equal publications collapse; duplicate facts are not an internal conflict.
            [machine, [descriptor, descriptor]], [otherMachine, [otherDescriptor]],
            [conflictedMachine, [descriptor, otherDescriptor]],
        ] as const) {
            rpc.mockResolvedValue({ protocolVersion: 1, projection: { ...projection, familiesById: { connectedAccounts: {
                family: 'connectedAccounts', entriesById: Object.fromEntries(descriptors.map((value, index) => [String(index), value])),
            } } } });
            await loadDaemonMergedProjectionInputs({ serverId: server.id, machineId: target.id, accountLifetime });
        }
        for (const target of [machine, otherMachine, unansweredMachine, conflictedMachine]) {
            machineAgentInventoryStore.publish(serverAccountScopedResourceKey(scope, 'machine-agents', target.id), {
                status: 'ready', items: [{ ...item, signIn: { status: 'signedOut', loginSupport: 'login_terminal' } }], lastCheckedAt: 12,
            });
        }
        rpc.mockClear();
        try {
            const { projectMachineAgentForCredential } = await import('./machineAgentModel');
            const credentialBindings = { v: 2 as const, bindingsByServiceId: {
                'acme.review/account': { source: 'connected' as const, selection: 'profile' as const, profileId: 'work' },
            } };
            const hook = await renderHook(({ machineId }) => useMachineAgents({ serverId: server.id, machineId, load: false }),
                { initialProps: { machineId: machine.id } });
            const selected = () => projectMachineAgentForCredential(hook.getCurrent().agents[0]!, { credentialBindings });
            await vi.waitFor(() => expect(selected()).toMatchObject({ state: 'ready', signIn: {
                status: 'signedIn', via: { kind: 'connected', profileLabel: 'Work account' },
            } }));
            expect(isMachineAgentReady(selected())).toBe(true);
            await hook.rerender({ machineId: otherMachine.id });
            await vi.waitFor(() => expect(selected()).toMatchObject({ state: 'needsSignIn', signIn: { status: 'signedOut' } }));
            for (const target of [unansweredMachine, conflictedMachine]) {
                await hook.rerender({ machineId: target.id });
                await vi.waitFor(() => expect(selected()).toMatchObject({ state: 'unknown', signIn: { status: 'unknown' } }));
                expect(isMachineAgentReady(selected())).toBe(false);
            }
            expect(getConnectedServiceRegistrySnapshot()).toMatchObject({ status: 'conflict', entries: [{ executable: false,
                projectedDescriptorCandidates: expect.arrayContaining([descriptor, otherDescriptor]) }] });
            await hook.rerender({ machineId: machine.id });
            expect(rpc).not.toHaveBeenCalled();
            await act(async () => storage.setState({ profile: { ...storage.getState().profile, connectedAccountsV4: [] } }));
            expect(hook.getCurrent().agents[0]).toMatchObject({ state: 'needsSignIn', signIn: { status: 'signedOut' } });
            await hook.unmount();
        } finally {
            retireConnectedAccountDescriptorProjection(accountLifetime);
            resetServerFeaturesClientForTests();
        }
    });

    it('keeps Account agent defaults available when no administration machine is selected', async () => {
        const { useAgentAdministrationCatalog } = await import('@/components/settings/agents/collection/useAgentAdministrationCatalog');
        const { useAgentCollection } = await import('@/components/settings/agents/collection/AgentCollectionList');
        const hook = await renderHook(() => {
            const catalog = useAgentAdministrationCatalog();
            return { target: catalog.executionTarget, ...useAgentCollection(catalog, '') };
        });

        expect(hook.getCurrent().target).toBeNull();
        expect(hook.getCurrent().detecting).toBe(false);
        expect(rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });

    it('accepts an authoritative empty session roster without asking for CLI probes', async () => {
        const server = await network.addHome('https://empty-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: 'empty-roster', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] } });
        rpc.mockResolvedValue({ protocolVersion: 1, projection: emptyProjection });
        await refreshMachineAgents({ serverId: server.id, machineId: machine.id, accountLifetime: { scope, isCurrent: () => true, onRetire: () => ({ dispose() {} }) } });
        expect(machineAgentInventoryStore.read(serverAccountScopedResourceKey(scope, 'machine-agents', machine.id))).toMatchObject({ status: 'ready', agents: [] });
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('marks retained summary facts stale on disconnect and does not probe on mount or reconnect', async () => {
        const server = await network.addHome('https://summary-inventory.example.test', 'inventory-account');
        const scope = { serverId: server.id, accountId: 'inventory-account' };
        const machine = createMachineFixture({ id: 'summary-machine', active: true, activeAt: Date.now(), daemonStateVersion: 1 });
        storage.setState({ machineListByServerId: { [server.id]: [machine] }, profileScope: scope });
        const key = serverAccountScopedResourceKey(scope, 'machine-agents', machine.id);
        machineAgentInventoryStore.publish(key, { status: 'ready', items: [item], lastCheckedAt: 12 });
        const hook = await renderHook(() => useMachineAgentsByMachine({ serverId: server.id, machineIds: [machine.id], load: false }));
        await vi.waitFor(() => expect(hook.getCurrent().get(machine.id)?.agents[0]?.stale).toBe(false));
        await act(async () => storage.setState({ machineListByServerId: { [server.id]: [{ ...machine, active: false, activeAt: 0 }] } }));
        expect(hook.getCurrent().get(machine.id)).toMatchObject({ status: 'offline', agents: [{ installed: true, stale: true }], lastCheckedAt: 12 });
        await act(async () => storage.setState({ machineListByServerId: { [server.id]: [machine] } }));
        expect(hook.getCurrent().get(machine.id)?.agents[0]?.stale).toBe(true);
        expect(rpc).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
