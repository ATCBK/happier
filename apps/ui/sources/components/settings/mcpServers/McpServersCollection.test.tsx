import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SESSION_ORGANIZATION_SNAPSHOT_VERSION } from '@happier-dev/protocol/sessions/organization/constants';
import { PromptLibraryCatalogKeyV1Schema, PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { emptyPromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryCatalogV1';
import type { RegistryItemSummaryV1 } from '@happier-dev/protocol/registries';
import type { CapabilityAddModalConfig } from '@/components/capabilities/add/CapabilityAddModal';

import type {
    DetectedMcpServerV1,
    McpServersSettingsV1,
} from '@happier-dev/protocol';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { createDeferred, renderHook } from '@/dev/testkit';
import { renderInCollectionLayout } from '@/dev/testkit/render/renderInCollectionLayout';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

import {
    installMcpServersCommonModuleMocks,
    mcpServersModuleState,
    resetMcpServersCommonModuleMockState,
} from './mcpServersTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

function createEmptyDetectedServersResponse() {
    return { ok: true, servers: [] as DetectedMcpServerV1[] };
}

function createEmptyPreviewResponse() {
    return { ok: true, builtIn: [], managed: [], detected: [] as [] };
}

// Validate fake daemon receipts before dispatch so fixture drift cannot masquerade as a lost Socket acknowledgement.
const successfulTestReceipt = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.test'].parse({
    ok: true, toolCount: 1, durationMs: 2, tools: [{ name: 'write', tokens: 10 }],
});
const missingRuntimeTestReceipt = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.servers.test'].parse({
    ok: false, errorCode: 'mcp_connect_failed', error: 'Runtime unavailable', runtimeMissing: 'npx', durationMs: 2,
});

const {
    routerPushSpy,
    routerReplaceSpy,
    routerSetParamsSpy,
} = vi.hoisted(() => ({
    routerPushSpy: vi.fn(),
    routerReplaceSpy: vi.fn(),
    routerSetParamsSpy: vi.fn(),
}));

const settingsState: { value: McpServersSettingsV1 } = {
    value: { v: 1, strictMode: false, servers: [], bindings: [] },
};

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

vi.mock('@/platform/randomUUID', () => ({
    randomUUID: () => 'uuid',
}));

function installMcpServersScreenMocks() {
    installMcpServersCommonModuleMocks({
        realComponents: true,
        reactNative: async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock({
                Dimensions: { get: () => ({ width: 1440, height: 900 }) },
            });
        },
        storage: (importOriginal) => importOriginal(),
        router: async () => {
            const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
            return createExpoRouterMock({
                pathname: '/(app)/settings/mcp-servers',
                params: () => mcpServersModuleState.routerSearchParams,
                segments: ['(app)', 'settings', 'mcp-servers'],
                router: {
                    push: routerPushSpy,
                    replace: routerReplaceSpy,
                    back: mcpServersModuleState.routerBackSpy,
                    setParams: routerSetParamsSpy,
                },
            }).module;
        },
        modal: async () => {
            const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
            return createModalModuleMock({ confirmResult: true }).module;
        },
    });
}

installMcpServersScreenMocks();
vi.doUnmock('@/sync/domains/state/storage');

// Load the real owners during collection rather than spending a test's deadline
// transforming the cold Home/action graph.
const { storage } = await import('@/sync/domains/state/storageStore');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
const { setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { resolveFreshMachineAdministrationExecutionTarget, useMachineAdministrationTargetSelection } = await import('@/sync/domains/machines/administration/useTargetSelection');
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { refreshMcpServerCatalog, resetMcpServerCatalogEngineForTests } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { McpSettingsIndex } = await import('./McpSettingsIndex');
const { McpServerCollection } = await import('./collection/McpServerCollection');
const { McpDetectedServersScreen } = await import('./McpDetectedServersScreen');
const { getMcpServerCatalogSnapshot, resetMcpServerCatalogSnapshotsForTests } = await import('@/sync/store/settings/mcpServerCatalogSnapshot');
const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
const { useMcpServerTools } = await import('./tools/useMcpServerTools');
const { McpServerToolsSection } = await import('./tools/McpServerToolsSection');
const { McpServerDetailPage } = await import('./detail/McpServerDetailPage');
const { McpServerWhereAndTools } = await import('./detail/McpServerDetailBody');
const { useMcpServerDetail } = await import('./detail/McpServerDetailBody');
const { McpAddModal } = await import('./add/openMcpAddModal');
const { CapabilityAddModalBody } = await import('@/components/capabilities/add/CapabilityAddModal');
const { CapabilityBlockingBanner } = await import('@/components/capabilities/detail/CapabilityBlockingBanner');
const { resolveSavedSecretReference } = await import('@/sync/store/settings/savedSecretCatalogSnapshot');
const { useMcpServerMachineTests } = await import('./status/useMcpServerMachineTests');
const { readPresentationNotice, retirePresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
const initialState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let disposeActionExecutorModuleLoader: (() => void) | undefined;
let machineHome: Awaited<ReturnType<typeof upsertServerProfileOnly>>;
let detectedResponse = createEmptyDetectedServersResponse();
let catalogRevision = 1;
let accountSettingsVersion = 1;
let accountSettings: Record<string, unknown> = {};
let targetMachineUnavailable = false;
let catalogReadGate: ReturnType<typeof createDeferred<void>> | null = null;
let testResponseGate: ReturnType<typeof createDeferred<void>> | null = null;
let runtimeMissing = false;
let registryOAuth = false;
const catalogWrites: unknown[] = [];
const accountSettingsWrites: unknown[] = [];
const rpcRequests: Array<Readonly<{ home: string | undefined; method: string; input: unknown }>> = [];
const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now(), metadata: {
    host: 'machine-1.local', displayName: 'Machine 1', platform: 'darwin', happyCliVersion: '0.0.0-test',
    happyHomeDir: '/Users/tester/.happy-dev', homeDir: '/Users/tester',
} });
const targetMachine = createMachineFixture({ id: 'machine-target', activeAt: Date.now(), metadata: {
    ...machine.metadata!, host: 'target.local', displayName: 'Target machine',
} });

async function refreshCatalogFixture() {
    if (!connection) throw new Error('The collection Home must be restored');
    await refreshMcpServerCatalog({ serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId: 'collection-owner' });
}

async function selectMachineFixture(target: { serverIdentityId: string; machineId: string }) {
    const selection = await renderHook(() => useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers));
    try {
        await vi.waitFor(() => expect(selection.getCurrent().candidates.some(candidate =>
            candidate.target.serverIdentityId === target.serverIdentityId && candidate.target.machineId === target.machineId)).toBe(true));
        await act(async () => { selection.getCurrent().selectTarget(target); });
        await vi.waitFor(() => {
            const current = selection.getCurrent();
            const state = storage.getState();
            expect(current.selectedTarget, JSON.stringify({ home: connection?.home.id, target, candidates: current.candidates,
                selectionState: current.state.kind, canExecute: current.canExecute,
                settingsScope: state.settingsScope, profileScope: state.profileScope, isDataReady: state.isDataReady })).toEqual(target);
        });
    } finally { await selection.unmount(); }
}

afterEach(async () => {
    testResponseGate?.resolve();
    testResponseGate = null;
    retirePresentationNotice();
    catalogReadGate?.resolve();
    catalogReadGate = null;
    await standardCleanup();
    await connection?.dispose();
    connection = null;
    resetMcpServerCatalogEngineForTests();
    resetMcpServerCatalogSnapshotsForTests();
    resetRuntimeFetch();
    storage.setState(initialState, true);
    vi.restoreAllMocks();
    disposeActionExecutorModuleLoader?.();
    disposeActionExecutorModuleLoader = undefined;
});

describe('MCP servers collection and tools', () => {
    beforeEach(async () => {
        resetMcpServersCommonModuleMockState();
        installMcpServersScreenMocks();
        routerPushSpy.mockReset();
        routerReplaceSpy.mockReset();
        routerSetParamsSpy.mockReset();
        detectedResponse = createEmptyDetectedServersResponse();
        catalogRevision = 1;
        accountSettingsVersion = 1;
        catalogWrites.length = 0;
        accountSettingsWrites.length = 0;
        rpcRequests.length = 0;
        targetMachineUnavailable = false;
        runtimeMissing = false;
        registryOAuth = false;
        accountSettings = { mcpServersStrictMode: false, actionsSettingsV1: { v: 1, approvalWaivedSurfaces: {
            'mcp.found.list': ['ui'], 'mcp.servers.create': ['ui'], 'settings.set': ['ui'],
        } } };
        settingsState.value = {
            v: 1,
            strictMode: false,
            servers: [{
                id: 'server-1',
                name: 'playwright',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
                env: {},
                createdAt: 1,
                updatedAt: 1,
            }],
            bindings: [{
                id: 'binding-1',
                serverId: 'server-1',
                enabled: true,
                target: { t: 'machine', machineId: 'machine-1' },
                createdAt: 1,
                updatedAt: 1,
            }],
        };
        disposeActionExecutorModuleLoader = await installRealActionExecutorModuleLoader();
        const targetUrl = 'https://mcp-collection-machine.test';
        await upsertServerProfileOnly({ serverUrl: targetUrl, name: 'Machine Home' });
        const targetHome = await setServerProfileIdentityForUrl(targetUrl, 'srv_mcp_collection_machine');
        if (!targetHome) throw new Error('Expected the Machine Home identity');
        machineHome = targetHome;
        const token = (accountId: string) => `e30.${Buffer.from(JSON.stringify({ sub: accountId,
            provenance: { v: 1, kind: 'account', authority: 'present_user' }, tokenEpoch: 0 })).toString('base64url')}.signature`;
        const credentials = { token: token('collection-owner') };
        await TokenStorage.setCredentialsForServerUrl('https://mcp-collection.test', {}, credentials);
        await TokenStorage.setCredentialsForServerUrl(targetUrl, { serverId: targetHome.id }, { token: token('machine-owner') });
        installDisconnectedServerSocketBoundary((socket, home) => {
            // The fake network acknowledges genuine request-correlated RPC envelopes;
            // Machine resolution, Actions, admission, and codecs all stay real.
            socket.connected = true;
            socket.emitWithAck = vi.fn(async (event: string, payload: unknown) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
                if (!payload || typeof payload !== 'object') throw new Error('Expected a wire RPC request');
                const method = Reflect.get(payload, 'method');
                if (typeof method !== 'string') throw new Error('Expected a wire RPC method');
                const content = { mode: 'plain' } as const;
                const request = await socketRpcCodec.decodeRequestParams(content, Reflect.get(payload, 'params'), method);
                rpcRequests.push({ home, method, input: request.params });
                if (method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)) {
                    await testResponseGate?.promise;
                    const result = runtimeMissing ? missingRuntimeTestReceipt : successfulTestReceipt;
                    return { ok: true, result: await socketRpcCodec.encodeResponse(content, result, request.callId) };
                }
                return { ok: true, result: await socketRpcCodec.encodeResponse(content,
                    method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT) ? detectedResponse : createEmptyPreviewResponse(), request.callId) };
            });
        });
        const request: Parameters<typeof setRuntimeFetch>[0] = async (url, init) => {
            const parsed = new URL(String(url));
            const target = parsed.origin === targetUrl;
            const selectedMachine = target ? targetMachine : machine;
            const accountId = target ? 'machine-owner' : 'collection-owner';
            if (parsed.origin === 'https://registry.modelcontextprotocol.io') {
                const item = { server: { name: registryOAuth ? 'example.test/oauth-docs' : 'example.test/stdio-docs', title: 'Docs', description: 'Read documentation.', version: '1.0.0',
                    packages: registryOAuth ? [] : [{ registryType: 'npm', identifier: '@example/docs', version: '1.0.0', transport: { type: 'stdio' } }],
                    remotes: registryOAuth ? [{ type: 'streamable-http', url: 'https://docs.example.test/mcp' }] : [],
                }, _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active', isLatest: true } } };
                return Response.json(parsed.pathname.endsWith('/servers') ? { servers: [item], metadata: { count: 1 } } : item);
            }
            if (parsed.pathname.startsWith('/v1/account/') || parsed.pathname === '/v2/account/settings') {
                expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token(accountId)}`);
            }
            if (parsed.pathname === '/health' || parsed.pathname === '/v1/auth/ping') return Response.json({});
            if (parsed.pathname === '/v1/features' || parsed.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse({
                capabilities: { serverIdentity: { serverIdentityId: target ? 'srv_mcp_collection_machine' : 'srv_mcp_collection' } },
            }));
            if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: accountSettingsVersion }));
            if (parsed.pathname === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: accountId }));
            if (parsed.pathname === '/v2/sessions' || parsed.pathname === '/v2/sessions/active') return Response.json(V2SessionListResponseSchema.parse({ sessions: [], nextCursor: null, hasNext: false }));
            if (parsed.pathname === '/v2/session-organization') return Response.json(SessionOrganizationSnapshotResponseSchema.parse({
                snapshot: { schemaVersion: SESSION_ORGANIZATION_SNAPSHOT_VERSION, version: 0,
                    pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [] },
            }));
            if (parsed.pathname === '/v1/artifacts') return Response.json([]);
            if (parsed.pathname === PROMPT_LIBRARY_ROWS_ROUTE_V1) return Response.json({ status: 'listed', rows:
                PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: 1, content: { t: 'plain', v: emptyPromptLibraryRecordV1(key) } })) });
            if (parsed.pathname === '/v1/account/authoring-memory') return Response.json({ rows: [] });
            if (parsed.pathname === '/v1/account/project-rows/list') return Response.json({ status: 'listed', rows: [], coverage: 'complete' });
            if (parsed.pathname === '/v2/account/settings') {
                if (init?.method === 'POST') {
                    const mutation = AccountSettingsV2UpdateRequestSchema.parse(JSON.parse(String(init.body)));
                    if (mutation.content?.t !== 'plain') throw new Error('Expected a plain Account Settings write');
                    expect(mutation.expectedVersion).toBe(accountSettingsVersion);
                    accountSettingsWrites.push(mutation);
                    accountSettings = mutation.content.v;
                    accountSettingsVersion += 1;
                    return Response.json({ success: true, version: accountSettingsVersion });
                }
                return Response.json({ version: accountSettingsVersion, content: { t: 'plain', v: accountSettings } });
            }
            if (parsed.pathname === `/v1/machines/${selectedMachine.id}`) return Response.json({ machine: {
                ...selectedMachine, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
            } });
            if (parsed.pathname === `/v1/machines/${selectedMachine.id}/access`) {
                const custodian = { accountId, displayName: 'Machine owner' };
                return Response.json(MachineAccessGrantsListResponseV1Schema.parse({ machineId: selectedMachine.id, custodian,
                    access: { custodian, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
                    canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] }));
            }
            if (parsed.pathname === '/v1/machines') return target && targetMachineUnavailable
                ? Response.json({ error: 'unavailable' }, { status: 503 })
                : Response.json([createPlainMachineRowFixture({ id: selectedMachine.id, accountId })]);
            if (parsed.pathname === '/v1/account/entity-rows/mcp') {
                expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token(accountId)}`);
                if (init?.method === 'POST') {
                    const mutation = McpServerCatalogRowMutationV1Schema.parse(JSON.parse(String(init.body)));
                    if (mutation.content?.t !== 'plain') throw new Error('Expected a plain MCP catalog write');
                    expect(mutation.expectedRevision).toBe(catalogRevision);
                    catalogWrites.push(mutation);
                    settingsState.value = { ...mutation.content.v, strictMode: false };
                    catalogRevision += 1;
                    return Response.json({ status: 'updated', revision: catalogRevision, cursor: catalogRevision });
                }
                await catalogReadGate?.promise;
                const { strictMode: _strictMode, ...catalog } = settingsState.value;
                return Response.json({ status: 'present', revision: catalogRevision, content: { t: 'plain', v: catalog } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        setRuntimeFetch(request);
        await loadSyncSingletonForTests();
        connection = await restoreServerAccountForTest({ serverUrl: 'https://mcp-collection.test',
            serverIdentityId: 'srv_mcp_collection', accountId: 'collection-owner', credentials, request });
        setRuntimeFetch(request);
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId: 'collection-owner' };
        const { sync } = await import('@/sync/sync');
        await sync.refreshSessions({ awaitSessionListHydration: true });
        await vi.waitFor(() => expect(storage.getState().isDataReady).toBe(true));
        await vi.waitFor(() => expect(storage.getState().settingsScope).toEqual(scope));
        await vi.waitFor(() => expect(storage.getState().settings.actionsSettingsV1).toEqual(settingsParse(accountSettings).actionsSettingsV1));
        storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId });
        storage.getState().applyMachines([targetMachine], true, { sourceServerId: resolveServerProfileScopeIdForIdentifier(targetHome.id) });
        await selectMachineFixture({ serverIdentityId: 'srv_mcp_collection', machineId: machine.id });
        await refreshCatalogFixture();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockReset();
        vi.mocked(Modal.show).mockReset();
        vi.mocked(Modal.prompt).mockReset();
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
    });

    it('follows a real Test runtime failure from the saved-detail repair button to that Machine setup', async () => {
        runtimeMissing = true;
        const scope = storage.getState().settingsScope!;
        storage.getState().applyMachines([{ ...machine, metadata: { ...machine.metadata!,
            agentInventory: { checkedAt: Date.now(), installedAgentIds: ['claude'] },
        } }], true, { sourceServerId: scope.serverId });
        const server = settingsState.value.servers[0]!;
        const screen = await renderSettingsView(<McpServerDetailPage server={server} draftServer={server}
            catalogRevision={catalogRevision} secrets={[]} secretAvailability={{ resolveReference: ref => resolveSavedSecretReference(scope, [], ref) }}
            scope={scope} onCommitConfiguration={() => {}} configurationSaveState="idle" onRemove={() => {}}
            approvalNotice={null} onDuplicate={() => {}} onChangeServer={() => {}} />);
        await screen.pressByTestIdAsync('mcp.server.machines:action');
        await vi.waitFor(() => expect(screen.findByType(McpServerWhereAndTools).props.detail.tests.results).toMatchObject({
            [machine.id]: { ok: false, errorCode: 'mcp_connect_failed', runtimeMissing: 'npx', message: 'Runtime unavailable' },
        }));
        await vi.waitFor(() => expect(screen.findByType(CapabilityBlockingBanner).props.status).toMatchObject({ kind: 'cantrun', detail: 'npx' }));
        await screen.pressByTestIdAsync('mcp.server.banner.action');
        expect(routerPushSpy).toHaveBeenCalledWith(`/machines/${machine.id}/installables?serverId=${encodeURIComponent(scope.serverId)}`);
    });

    it('allows a tool directly and Undo restores acknowledged inheritance after the catalog refreshes', async () => {
        const server = settingsState.value.servers[0]!;
        settingsState.value = { ...settingsState.value, servers: [{ ...server,
            toolsSnapshot: { checkedAt: 1, machineId: machine.id, tools: [{ name: 'write', tokens: 10 }] },
        }] };
        await refreshCatalogFixture();
        let lastError: string | null | undefined;
        function Tools() {
            const tools = useMcpServerTools(server.id, catalogRevision);
            return <McpServerToolsSection testID="tools" status={tools.status} list={tools.list}
                agentName={id => id} installedAgentIds={[]} onChange={async patch => { lastError = await tools.set(patch); return lastError; }} />;
        }
        const screen = await renderSettingsView(<Tools />);
        await vi.waitFor(() => expect(screen.findByTestId('tools:tool:write:allow')).not.toBeNull());
        retirePresentationNotice();
        await screen.pressByTestIdAsync('tools:tool:write:allow');
        await vi.waitFor(() => expect(settingsState.value.servers[0]!.tools?.overrides.write).toBe('allow'));
        await refreshCatalogFixture();
        await vi.waitFor(() => expect(readPresentationNotice()?.undo, JSON.stringify({ lastError, error: screen.findByTestId('tools:error')?.props.diagnosticCode })).toBeDefined());
        await act(async () => { readPresentationNotice()!.undo!.run(); });
        await vi.waitFor(() => expect(settingsState.value.servers[0]!.tools?.overrides).toEqual({}));
        expect(settingsState.value.servers[0]!.tools?.default).toBe('ask');
        const { Modal } = await import('@/modal');
        expect(Modal.confirm).not.toHaveBeenCalled();
    });

    it.each([false, true])('carries the acknowledged Registry Add to the saved-page follow-up (OAuth=%s)', async oauth => {
        registryOAuth = oauth;
        const itemId = oauth ? 'example.test/oauth-docs' : 'example.test/stdio-docs';
        const query = oauth ? 'oauth' : 'stdio';
        const onAdded = vi.fn();
        const onClose = vi.fn();
        const screen = await renderSettingsView(React.createElement(McpAddModal, { params: { query, onAdded, onCustom() {} }, onClose }));
        // React's renderer exposes untyped component props at its boundary.
        const config = () => screen.tree.root.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<RegistryItemSummaryV1>;
        await vi.waitFor(() => expect(config().catalog.items.some(row => row.itemId === itemId)).toBe(true));
        const row = config().catalog.items.find(row => row.itemId === itemId)!;
        const details = await renderSettingsView(React.createElement(React.Fragment, null,
            config().renderDetail(row, { pushed: false, added: false })));
        await vi.waitFor(() => expect(config().detailFooter(row).primary.disabledReason).toBeUndefined());
        // Keep the exact pre-await shell callback: creation updates modal state
        // before the shell closes, so this also catches stale callback captures.
        const before = config();
        let receipt!: Awaited<ReturnType<ReturnType<typeof before.detailFooter>['primary']['onPress']>>;
        await act(async () => { receipt = await before.detailFooter(row).primary.onPress(); });
        if (!receipt) throw new Error('Expected an acknowledged create');
        before.onAdded?.(receipt);
        expect(onAdded).toHaveBeenCalledWith('uuid', { afterRegistryAdd: true });
        const added = settingsState.value.servers.find(server => server.id === 'uuid');
        expect(added?.remote?.auth?.kind === 'oauth').toBe(oauth);
        expect(catalogWrites).toHaveLength(1);
        expect(rpcRequests.filter(request => request.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST))).toEqual([]);
        await details.unmount();
        await screen.unmount();
        const openAdded = vi.fn();
        const reopened = await renderSettingsView(React.createElement(McpAddModal, { params: { query, onAdded: openAdded, onCustom() {} }, onClose }));
        const reopenedConfig = () => reopened.tree.root.findByType(CapabilityAddModalBody).props.config as CapabilityAddModalConfig<RegistryItemSummaryV1>;
        const open = await reopenedConfig().detailFooter(row).primary.onPress();
        if (!open) throw new Error('Expected an existing server');
        reopenedConfig().onAdded?.(open);
        expect(openAdded).toHaveBeenCalledWith('uuid', undefined);
        expect(catalogWrites).toHaveLength(1);
    });

    it.each([true, false])('runs one administrative Test only for the Registry Add navigation intent (%s)', async afterRegistryAdd => {
        settingsState.value = { ...settingsState.value, servers: settingsState.value.servers.map(server => ({ ...server,
            origin: { kind: 'registry', provenance: { sourceId: 'source', itemId: 'docs', format: 'mcp-registry',
                sourceUrl: 'https://registry.example.test', ref: { kind: 'version', version: '1.0.0' }, importedAt: 1 } },
        })) };
        await refreshCatalogFixture();
        await selectMachineFixture({ serverIdentityId: 'srv_mcp_collection', machineId: machine.id });
        mcpServersModuleState.routerSearchParams = afterRegistryAdd ? { afterRegistryAdd: '1' } : {};
        const server = settingsState.value.servers[0]!;
        const scope = storage.getState().settingsScope;
        const hook = await renderHook(() => useMcpServerDetail(server, catalogRevision, {
            resolveReference: ref => resolveSavedSecretReference(scope, [], ref),
        }));
        if (afterRegistryAdd) {
            await vi.waitFor(() => expect(routerSetParamsSpy).toHaveBeenCalledWith({ afterRegistryAdd: undefined }));
            await vi.waitFor(() => expect(hook.getCurrent().tests.results[machine.id]).toMatchObject({ ok: true }));
        }
        else await flushHookEffects();
        expect(rpcRequests.filter(request => request.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)))
            .toHaveLength(afterRegistryAdd ? 1 : 0);
        if (afterRegistryAdd) expect(routerSetParamsSpy).toHaveBeenCalledWith({ afterRegistryAdd: undefined });
        await hook.rerender();
        await flushHookEffects();
        expect(rpcRequests.filter(request => request.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_TEST)))
            .toHaveLength(afterRegistryAdd ? 1 : 0);
    });

    it('retires held Test facts on configuration and Account changes, including when reopened', async () => {
        const hook = await renderHook(() => useMcpServerMachineTests('server-1'));
        await act(async () => { hook.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(hook.getCurrent().results[machine.id]).toMatchObject({ ok: true }));
        await hook.unmount();
        const reopened = await renderHook(() => useMcpServerMachineTests('server-1'));
        expect(reopened.getCurrent().results[machine.id]).toMatchObject({ ok: true });
        testResponseGate = createDeferred<void>();
        const before = rpcRequests.length;
        await act(async () => { reopened.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(rpcRequests.length).toBeGreaterThan(before));
        settingsState.value = { ...settingsState.value, servers: settingsState.value.servers.map(server => ({ ...server,
            stdio: { command: 'different-runtime', args: [] },
        })) };
        catalogRevision += 1;
        await act(async () => { await refreshCatalogFixture(); });
        await vi.waitFor(() => expect(reopened.getCurrent().results).toEqual({}));
        await act(async () => { testResponseGate!.resolve(); });
        await vi.waitFor(() => expect(reopened.getCurrent().running.size).toBe(0));
        expect(reopened.getCurrent().results).toEqual({});
        testResponseGate = null;
        await act(async () => { reopened.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(reopened.getCurrent().results[machine.id]).toMatchObject({ ok: true }));
        testResponseGate = createDeferred<void>();
        const nextBefore = rpcRequests.length;
        await act(async () => { reopened.getCurrent().run([machine.id]); });
        await vi.waitFor(() => expect(rpcRequests.length).toBeGreaterThan(nextBefore));
        const profileScope = storage.getState().profileScope!;
        await act(async () => { storage.getState().activateProfileScope({ ...profileScope, accountId: 'other-account' }); });
        expect(reopened.getCurrent().results).toEqual({});
        await act(async () => { testResponseGate!.resolve(); });
        await reopened.unmount();
        await act(async () => { storage.getState().activateProfileScope(profileScope); });
        const returned = await renderHook(() => useMcpServerMachineTests('server-1'));
        expect(returned.getCurrent().results).toEqual({});
    });

    it('invites an empty collection on the list page with Browse first and Paste a config beside it', async () => {
        settingsState.value = { v: 1, strictMode: false, servers: [], bindings: [] };
        await refreshCatalogFixture();
        const screen = await renderInCollectionLayout(React.createElement(McpSettingsIndex), 'stacked');
        const invitation = screen.find((node) => node.props?.testID === 'settings.mcpServers.invitation' && node.props?.primaryAction !== undefined);
        expect(invitation!.props.primaryAction.testID).toBe('settings.mcpServers.invitation.add');
        expect(invitation!.props.secondaryAction.testID).toBe('settings.mcpServers.invitation.paste');
        // Both open the one Add modal (P7 U7.10), never a page of their own.
        const { Modal } = await import('@/modal');
        await act(async () => { invitation!.props.primaryAction.onPress(); });
        await act(async () => { invitation!.props.secondaryAction.onPress(); });
        expect(vi.mocked(Modal.show)).toHaveBeenCalledTimes(2);
        expect(routerPushSpy).not.toHaveBeenCalled();
    });

    it('beside the rail, an empty collection is the brand-new homepage', async () => {
        settingsState.value = { v: 1, strictMode: false, servers: [], bindings: [] };
        await refreshCatalogFixture();
        const screen = await renderInCollectionLayout(React.createElement(McpSettingsIndex), 'split');
        expect(screen.find((node) => node.props?.testID === 'mcp.home.header' && typeof node.props?.title === 'string')!.props.title)
            .toBe('capabilities.mcpHome.newTitle');
        expect(screen.findByTestId('mcp.home.browse')).not.toBeNull();
        expect(screen.findByTestId('mcp.home.paste')).not.toBeNull();
    });

    it('lists each server with where it applies, flags one that applies nowhere, and adds in the collection', async () => {
        settingsState.value = {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 'server-1', name: 'playwright', transport: 'stdio',
                    stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, env: {}, createdAt: 1, updatedAt: 1,
                },
                {
                    id: 'server-2', name: 'context7', transport: 'http', remote: { url: 'https://example.com/mcp', headers: {} },
                    env: {}, createdAt: 2, updatedAt: 2,
                },
            ],
            bindings: [{
                id: 'binding-1', serverId: 'server-1', enabled: true,
                target: { t: 'machine', machineId: 'machine-1' }, createdAt: 1, updatedAt: 1,
            }],
        };
        await refreshCatalogFixture();
        const screen = await renderSettingsView(React.createElement(McpServerCollection, { variant: 'rail', selectedServerId: 'server-1' }));

        const bound = screen.find(node => node.props.testID === 'mcp.server.card.server-1'
            && typeof node.props.whereSummary === 'string');
        expect(bound!.props.title).toBe('playwright');
        expect(bound!.props.whereSummary).toBe('capabilities.where.only');
        expect(bound!.props.selected).toBe(true);
        const unbound = screen.find(node => node.props.testID === 'mcp.server.card.server-2'
            && typeof node.props.whereSummary === 'string');
        expect(unbound!.props.whereSummary).toBe('capabilities.where.off');
        expect(screen.findGroup('capabilities.mcp.inUse')).not.toBeNull();
        expect(screen.findGroup('capabilities.mcp.off')).not.toBeNull();
        expect(screen.findByTestId('settings.mcpServers.builtIn.happier')).not.toBeNull();

        await screen.pressRow('mcp.server.card.server-2');
        await vi.waitFor(() => expect(routerReplaceSpy).toHaveBeenLastCalledWith('/settings/mcp/server-2'));

        // The rail's "+" opens the one Add modal; nothing navigates until a server is added.
        const { Modal } = await import('@/modal');
        await act(async () => { screen.findByTestId('settings.mcpServers.addServer')!.props.onPress(); });
        expect(vi.mocked(Modal.show)).toHaveBeenCalledWith(expect.objectContaining({
            chrome: expect.objectContaining({ testID: 'mcp.add' }),
        }));
    });

    it('scans every discovery source and enables adoption only after the Account catalog is writable', async () => {
        detectedResponse = {
            ok: true,
            servers: [{
                provider: 'codex',
                name: 'github',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
                envKeys: [],
                enabled: true,
                source: { kind: 'user', path: '~/.codex/config.toml' },
            }],
        };
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection!.home.id), accountId: 'collection-owner' };
        const screen = await renderSettingsView(React.createElement(McpDetectedServersScreen));
        await flushHookEffects();

        // No provider filter travels: the selected machine's daemon scans every
        // MCP discovery source its own registry holds, including an installed
        // Agent's, instead of this binary's bundled Agent list.
        await vi.waitFor(() => expect(rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT))).toEqual([
            { home: connection!.home.serverUrl, method: `machine-1:${RPC_METHODS.DAEMON_MCP_SERVERS_DETECT}`, input: { machineId: 'machine-1' } },
        ]));
        await vi.waitFor(() => expect(screen.findByTestId('mcp.detected.import.0')).not.toBeNull());
        const importButton = () => screen.find(node => node.props.testID === 'mcp.detected.import.0'
            && typeof node.props.disabled === 'boolean');
        await vi.waitFor(() => expect(importButton().props.disabled).toBe(false));
        catalogReadGate = createDeferred<void>();
        let refreshing!: Promise<void>;
        act(() => { refreshing = refreshMcpServerCatalog(scope); });
        await flushHookEffects();
        // Discovery can finish while this Account's catalog is still refreshing.
        // Keep the found row, but do not offer a write the current authority refuses.
        expect(getMcpServerCatalogSnapshot(scope)).toMatchObject({ status: 'loading', authority: 'active', stale: true, revision: 1 });
        await vi.waitFor(() => expect(screen.find(node => node.props.testID === 'settings.mcpServers.detect.refresh'
            && typeof node.props.disabled === 'boolean').props.disabled).toBe(false));
        await vi.waitFor(() => expect(importButton().props.disabled).toBe(true));
        expect(catalogWrites).toEqual([]);
        await act(async () => { catalogReadGate!.resolve(); await refreshing; });
        await vi.waitFor(() => expect(importButton().props.disabled).toBe(false));

        await act(async () => {
            await screen.find((node) => node.props?.testID === 'mcp.detected.import.0' && typeof node.props?.onPress === 'function').props.onPress();
        });
        await flushHookEffects();

        const { Modal } = await import('@/modal');
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(Modal.alert).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(catalogWrites).toHaveLength(1));
        const written = settingsState.value;
        const imported = written.servers.find((server) => server.name === 'github');
        expect(imported).toBeTruthy();
        await vi.waitFor(() => expect(routerReplaceSpy).toHaveBeenLastCalledWith(`/settings/mcp/${imported!.id}`));
        expect(written.bindings.find(binding => binding.serverId === imported!.id)?.target).toEqual({ t: 'allMachines' });
        expect(accountSettingsWrites).toEqual([]);
    });

    it.each([
        ['a future settings version', {
            v: 2,
            strictMode: false,
            servers: [],
            bindings: [],
        }],
        ['a schema-invalid duplicate server id', {
            v: 1,
            strictMode: false,
            servers: [
                {
                    id: 'duplicate',
                    name: 'first',
                    transport: 'stdio',
                    stdio: { command: 'node', args: [] },
                    env: {},
                    createdAt: 1,
                    updatedAt: 1,
                },
                {
                    id: 'duplicate',
                    name: 'second',
                    transport: 'stdio',
                    stdio: { command: 'node', args: [] },
                    env: {},
                    createdAt: 2,
                    updatedAt: 2,
                },
            ],
            bindings: [],
        }],
        ['an additive field from a newer writer', {
            v: 1,
            strictMode: false,
            servers: [],
            bindings: [],
            futureV2: { retained: true },
        }],
    ] satisfies ReadonlyArray<readonly [string, unknown]>)('changes failure policy without overwriting retained legacy MCP data (%s)', async (_case, rawSettings) => {
        accountSettings = { ...accountSettings, mcpServersSettingsV1: rawSettings };
        storage.setState({ settings: settingsParse(accountSettings) });
        // Exercise the Settings owner independently of the catalog observer's legitimate legacy transfer.
        await act(async () => {
            const result = await createFrontDoorActionExecute()('settings.set', {
                anchor: 'session.mcpServersStrictMode', value: true,
            }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
                serverId: connection!.home.id, expectedAccountId: 'collection-owner' });
            expect(result).toMatchObject({ ok: true });
        });

        await vi.waitFor(() => expect(accountSettings).toMatchObject({ mcpServersStrictMode: true, mcpServersSettingsV1: rawSettings }));
        expect(accountSettingsWrites).toEqual(expect.arrayContaining([
            expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
                mcpServersStrictMode: true, mcpServersSettingsV1: rawSettings,
            }) } }),
        ]));
        expect(accountSettings.mcpServersSettingsV1).toEqual(rawSettings);
        expect(catalogWrites).toEqual([]);
    });

    it('refreshes detected servers when the user requests a detect pass with the current context', async () => {
        detectedResponse = {
            ok: true,
            servers: [{
                provider: 'codex',
                name: 'playwright',
                transport: 'stdio',
                stdio: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] },
                envKeys: [],
                enabled: true,
                source: { kind: 'user', path: '~/.codex/config.toml' },
            }],
        };
        const screen = await renderSettingsView(React.createElement(McpDetectedServersScreen));
        await flushHookEffects();

        await vi.waitFor(() => expect(screen.findRow('mcp.detected.card.0')).toBeTruthy());
        await vi.waitFor(() => expect(screen.find(node => node.props.testID === 'settings.mcpServers.detect.refresh'
            && typeof node.props.loading === 'boolean').props.loading).toBe(false));

        await act(async () => {
            screen.changeTextByTestId('settings.mcpServers.detect.directoryInput', '/repo/project');
        });
        await flushHookEffects();
        expect(screen.findByTestId('settings.mcpServers.detect.directoryInput')?.props.value).toBe('/repo/project');

        const detectedRowAfterRefresh = screen.findRow('mcp.detected.card.0');
        expect(detectedRowAfterRefresh).toBeTruthy();
        expect(rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT))).toHaveLength(1);
        await vi.waitFor(() => expect(screen.find(node => node.props.testID === 'settings.mcpServers.detect.refresh'
            && typeof node.props.disabled === 'boolean').props.disabled).toBe(false));
        await act(async () => { await screen.pressByTestIdAsync('settings.mcpServers.detect.refresh'); });
        await flushHookEffects();

        await vi.waitFor(() => expect(rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT)).at(-1)).toEqual({
            home: connection!.home.serverUrl, method: `machine-1:${RPC_METHODS.DAEMON_MCP_SERVERS_DETECT}`,
            input: { machineId: 'machine-1', directory: '/repo/project' },
        }));
        expect(rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT))).toHaveLength(2);
    });

    it('uses the fresh Administration target and fails closed after it becomes unavailable', async () => {
        await selectMachineFixture({ serverIdentityId: 'srv_mcp_collection_machine', machineId: targetMachine.id });

        const screen = await renderSettingsView(React.createElement(McpDetectedServersScreen));
        await flushHookEffects();

        await vi.waitFor(() => expect(rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT))).toEqual([
            { home: machineHome.serverUrl, method: `machine-target:${RPC_METHODS.DAEMON_MCP_SERVERS_DETECT}`, input: { machineId: 'machine-target' } },
        ]));
        await vi.waitFor(() => expect(screen.find((node) => node.props?.testID === 'settings.mcpServers.detect.refresh'
            && typeof node.props?.loading === 'boolean').props.loading).toBe(false));

        rpcRequests.length = 0;
        targetMachineUnavailable = true;
        await act(async () => {
            storage.getState().markMachineListUnavailable(machineHome.id);
        });
        expect(resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: 'srv_mcp_collection_machine', machineId: targetMachine.id })).toBeNull();
        await act(async () => {
            await screen.pressRow('settings.mcpServers.detect.refresh');
        });

        expect(rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT))).toEqual([]);
    });
});
