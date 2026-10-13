import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { MachineAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { AccountSettingsV2UpdateRequestSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { McpServerCatalogRowMutationV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';

import type {
    DetectedMcpServerV1,
    McpServersSettingsV1,
} from '@happier-dev/protocol';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderInCollectionLayout } from '@/dev/testkit/render/renderInCollectionLayout';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
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
const { listMcpPreviewAgentIds } = await import('./mcpServerScreenHelpers');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
const { setServerProfileIdentityForUrl, resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { resolveFreshMachineAdministrationExecutionTarget } = await import('@/sync/domains/machines/administration/useTargetSelection');
const { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } = await import('@/sync/domains/machines/administration/selectionPreferences');
const { refreshMcpServerCatalog } = await import('@/sync/engine/settings/mcpServerCatalogEngine');
const { resetRuntimeFetch, setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { McpSettingsIndex } = await import('./McpSettingsIndex');
const { McpServerCollection } = await import('./collection/McpServerCollection');
const { McpDetectedServersScreen } = await import('./McpDetectedServersScreen');
const { McpSessionPreviewScreen } = await import('./McpSessionPreviewScreen');
const { McpPreviewServersTab } = await import('./McpPreviewServersTab');
const initialState = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let disposeActionExecutorModuleLoader: (() => void) | undefined;
let machineHome: Awaited<ReturnType<typeof upsertServerProfileOnly>>;
let detectedResponse = createEmptyDetectedServersResponse();
let catalogRevision = 1;
let accountSettingsVersion = 1;
let accountSettings: Record<string, unknown> = {};
let targetMachineUnavailable = false;
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

function selectMachineFixture(target: { serverIdentityId: string; machineId: string }) {
    storage.setState((state) => ({ settings: { ...state.settings,
        machineAdministrationTargetsLocalV1: { [MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers]: target },
    } }));
}

afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = null;
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
                return { ok: true, result: await socketRpcCodec.encodeResponse(content,
                    method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT) ? detectedResponse : createEmptyPreviewResponse(), request.callId) };
            });
        });
        const request: Parameters<typeof setRuntimeFetch>[0] = async (url, init) => {
            const parsed = new URL(String(url));
            const target = parsed.origin === targetUrl;
            const selectedMachine = target ? targetMachine : machine;
            const accountId = target ? 'machine-owner' : 'collection-owner';
            if (parsed.pathname.startsWith('/v1/account/') || parsed.pathname === '/v2/account/settings') {
                expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token(accountId)}`);
            }
            if (parsed.pathname === '/health' || parsed.pathname === '/v1/auth/ping') return Response.json({});
            if (parsed.pathname === '/v1/features' || parsed.pathname === '/v1/features/authenticated') return Response.json(createRootLayoutFeaturesResponse());
            if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture({ settingsVersion: accountSettingsVersion }));
            if (parsed.pathname === '/v1/artifacts') return Response.json([]);
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
                const { strictMode: _strictMode, ...catalog } = settingsState.value;
                return Response.json({ status: 'present', revision: catalogRevision, content: { t: 'plain', v: catalog } });
            }
            return Response.json({ error: 'not_found' }, { status: 404 });
        };
        setRuntimeFetch(request);
        connection = await restoreServerAccountForTest({ serverUrl: 'https://mcp-collection.test',
            serverIdentityId: 'srv_mcp_collection', accountId: 'collection-owner', credentials, request });
        await TokenStorage.setCredentialsForServerUrl(connection.home.serverUrl, { serverId: connection.home.id }, credentials);
        setRuntimeFetch(request);
        const scope = { serverId: resolveServerProfileScopeIdForIdentifier(connection.home.id), accountId: 'collection-owner' };
        storage.setState({ isDataReady: true, settings: settingsParse(accountSettings), settingsVersion: 1,
            settingsScope: scope, profileScope: scope });
        storage.getState().applyMachines([machine], true, { sourceServerId: scope.serverId });
        storage.getState().applyMachines([targetMachine], true, { sourceServerId: resolveServerProfileScopeIdForIdentifier(targetHome.id) });
        selectMachineFixture({ serverIdentityId: 'srv_mcp_collection', machineId: machine.id });
        await refreshCatalogFixture();
        const { Modal } = await import('@/modal');
        vi.mocked(Modal.alert).mockReset();
        vi.mocked(Modal.show).mockReset();
        vi.mocked(Modal.prompt).mockReset();
        vi.mocked(Modal.confirm).mockReset();
        vi.mocked(Modal.confirm).mockResolvedValue(true);
    });

    it.each(['land', 'list'] as const)('invites an empty collection with one primary way to add and retains machine tools (%s)', async (view) => {
        settingsState.value = { v: 1, strictMode: false, servers: [], bindings: [] };
        await refreshCatalogFixture();
        const screen = await renderInCollectionLayout(React.createElement(McpSettingsIndex), view === 'land' ? 'split' : 'stacked');
        const addMenu = screen.find((node) => node.props?.testID === 'settings.mcpServers.addMenu' && typeof node.props?.onSelect === 'function');
        // One primary: "Add MCP server" is the add menu's own trigger; no other way to add sits beside it.
        const trigger = addMenu.props.trigger({ open: false, toggle: () => {}, openMenu: () => {}, closeMenu: () => {}, selectedItem: null });
        expect(trigger.props.testID).toBe('settings.mcpServers.invitation.add');
        const otherWays = screen.findAll((node) => node.props?.testID?.startsWith?.('settings.mcpServers.invitation.')
            && (typeof node.props?.onPress === 'function' || typeof node.props?.action === 'function')
            && node.props.testID !== 'settings.mcpServers.invitation.add');
        expect(otherWays).toHaveLength(0);
        // The menu holds every way: configure, paste JSON, from this machine (and presets).
        expect(addMenu.props.items.map((item: { id: string }) => item.id)).toEqual(
            expect.arrayContaining(['configure', 'import-json', 'from-machine']),
        );
        expect(screen.findByTestId('settings.mcpServers.tool.onMachine')).not.toBeNull();
        expect(screen.findByTestId('settings.mcpServers.tool.preview')).not.toBeNull();
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

        const bound = screen.findRow('mcp.server.card.server-1');
        expect(bound!.props.title).toBe('playwright');
        expect(bound!.props.titleMeta.props.children).toBe('capabilities.where.only');
        expect(bound!.props.selected).toBe(true);
        const unbound = screen.findRow('mcp.server.card.server-2');
        expect(unbound!.props.titleMeta.props.children).toBe('capabilities.where.off');
        expect(screen.findGroup('capabilities.mcp.inUse')).not.toBeNull();
        expect(screen.findGroup('capabilities.mcp.off')).not.toBeNull();
        expect(screen.findByTestId('settings.mcpServers.builtIn.happier')).not.toBeNull();

        await screen.pressRow('mcp.server.card.server-2');
        await vi.waitFor(() => expect(routerReplaceSpy).toHaveBeenLastCalledWith('/settings/mcp/server-2'));

        const addMenu = screen.find((node) => node.props?.testID === 'settings.mcpServers.addMenu' && typeof node.props?.onSelect === 'function');
        await act(async () => { addMenu.props.onSelect('preset:playwright'); });
        expect(routerReplaceSpy).toHaveBeenLastCalledWith('/settings/mcp/new?addMode=quick-install&presetId=playwright');
        await act(async () => { addMenu.props.onSelect('configure'); });
        expect(routerReplaceSpy).toHaveBeenLastCalledWith('/settings/mcp/new');
        await act(async () => { addMenu.props.onSelect('from-machine'); });
        expect(routerReplaceSpy).toHaveBeenLastCalledWith('/settings/mcp/on-machine');
    });

    it('scans every discovery source on the managed machine and imports a found server into the collection', async () => {
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
        const screen = await renderSettingsView(React.createElement(McpDetectedServersScreen));
        await flushHookEffects();

        // No provider filter travels: the selected machine's daemon scans every
        // MCP discovery source its own registry holds, including an installed
        // Agent's, instead of this binary's bundled Agent list.
        await vi.waitFor(() => expect(rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT))).toEqual([
            { home: connection!.home.serverUrl, method: `machine-1:${RPC_METHODS.DAEMON_MCP_SERVERS_DETECT}`, input: { machineId: 'machine-1' } },
        ]));
        await vi.waitFor(() => expect(screen.findByTestId('mcp.detected.import.0')).not.toBeNull());
        // The scan and catalog read are independent; adoption needs the settled catalog authority.
        await act(async () => { await refreshCatalogFixture(); });

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

    it('offers every agent that receives MCP tools in the session preview and records the failure policy', async () => {
        const screen = await renderSettingsView(React.createElement(McpSessionPreviewScreen));

        const agentDropdown = screen.find((node) => node.props?.itemTrigger?.title === 'settings.mcpServersPreviewAgentTitle');
        expect(agentDropdown!.props.items.map((item: { id: string }) => item.id)).toEqual(listMcpPreviewAgentIds());

        await act(async () => {
            screen.find((node) => node.props?.testIDPrefix === 'settings.mcpServers.strictMode' && typeof node.props?.onChange === 'function').props.onChange('stop');
        });
        await vi.waitFor(() => expect(accountSettingsWrites).toHaveLength(1));
        expect(accountSettings).toMatchObject({ mcpServersStrictMode: true });
        expect(catalogWrites).toEqual([]);
    });

    it('says nothing would be delivered when a check finds no server, and names the agent\'s tool delivery', async () => {
        const common = {
            agentItems: [],
            selectedAgentTools: { delivery: 'native_mcp' } as never,
            selectedMachineId: 'machine-1',
            selectedServerId: 'server-1',
            canExecute: true,
            selectedAgentId: 'claude' as never,
            onSelectAgentId: vi.fn(),
            agentMenuOpen: false,
            onAgentMenuOpenChange: vi.fn(),
            directory: '/repo',
            onChangeDirectory: vi.fn(),
            loading: false,
            onRefresh: vi.fn(),
        };
        const unchecked = await renderSettingsView(React.createElement(McpPreviewServersTab, { ...common, preview: null }));
        expect(unchecked.findRow('settings.mcpServers.preview.empty')).toBeTruthy();
        expect(unchecked.findRow('settings.mcpServers.preview.nothing')).toBeFalsy();
        const delivery = unchecked.findRow('settings.mcpServers.preview.delivery');
        expect(delivery!.props.detail).toBe('settings.mcpServersDeliveryNativeTitle');

        const checked = await renderSettingsView(React.createElement(McpPreviewServersTab, {
            ...common,
            preview: { ok: true, builtIn: [], managed: [], detected: [] } as never,
        }));
        expect(checked.findRow('settings.mcpServers.preview.nothing')).toBeTruthy();
        expect(checked.findRow('settings.mcpServers.preview.empty')).toBeFalsy();
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
        const screen = await renderSettingsView(React.createElement(McpSessionPreviewScreen));

        await act(async () => {
            screen.find((node) => node.props?.testIDPrefix === 'settings.mcpServers.strictMode' && typeof node.props?.onChange === 'function').props.onChange('stop');
        });

        await vi.waitFor(() => expect(accountSettingsWrites).toHaveLength(1));
        expect(accountSettings).toMatchObject({ mcpServersStrictMode: true, mcpServersSettingsV1: rawSettings });
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

        await act(async () => {
            screen.changeTextByTestId('settings.mcpServers.detect.directoryInput', '/repo/project');
        });
        await flushHookEffects();

        const detectedRowAfterRefresh = screen.findRow('mcp.detected.card.0');
        expect(detectedRowAfterRefresh).toBeTruthy();
        expect(rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT))).toHaveLength(1);
        await act(async () => { await screen.pressByTestIdAsync('settings.mcpServers.detect.refresh'); });
        await flushHookEffects();

        await vi.waitFor(() => expect(rpcRequests.filter(item => item.method.includes(RPC_METHODS.DAEMON_MCP_SERVERS_DETECT)).at(-1)).toEqual({
            home: connection!.home.serverUrl, method: `machine-1:${RPC_METHODS.DAEMON_MCP_SERVERS_DETECT}`,
            input: { machineId: 'machine-1', directory: '/repo/project' },
        }));
    });

    it('uses the fresh Administration target and fails closed after it becomes unavailable', async () => {
        selectMachineFixture({ serverIdentityId: 'srv_mcp_collection_machine', machineId: targetMachine.id });

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
