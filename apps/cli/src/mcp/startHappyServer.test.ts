import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { accountSettingsParse, ActionsSettingsV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

const daemonCatalogBoundary = vi.hoisted(() => ({ read: vi.fn() }));

// The daemon control transport is outside the Session process; MCP/HTTP owners
// and catalog admission below it remain real.
vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    readDaemonPluginCatalog: daemonCatalogBoundary.read,
    // An available daemon with no contributed metadata Action returns unmatched;
    // the real Session Action owner then serves its built-in catalog.
    requestDaemonPluginActionExecution: async () => ({ matched: false }),
}));

import { registerHappierSessionAgentToolRpc, startHappyServer } from '@/mcp/startHappyServer';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createMutableApiSessionClientFixture } from '@/testkit/backends/sessionFixtures';

describe('startHappyServer notification stream', () => {
    it.each(['turn', 'native runtime'] as const)('keeps MCP discovery available across %s retirement while tool calls keep their cancellation scope', async (retirement) => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockImplementation(async (options?: Readonly<{ signal?: AbortSignal }>) => {
            options?.signal?.throwIfAborted();
            return { kind: 'available', plugins: [], tools: [] };
        });
        let lifetime = new AbortController();
        let nativeOpened = false;
        let turn = new AbortController();
        const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'reconnecting-mcp-session' }), {
            getRuntimeLifetimeSignal: () => nativeOpened ? lifetime.signal : null,
            getHostTurnAbortSignal: () => turn.signal,
            getWorkDepth: () => 0,
            getActiveTurnPermissionWitness: () => turn.signal.aborted || lifetime.signal.aborted ? null : ({ turnId: 'reconnecting-mcp-turn', workDepth: 0,
                causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } }),
        });
        const server = await startHappyServer(session, {
            sessionCredentials: { token: 'reconnecting-mcp-fixture', encryption: null }, accountSettings: accountSettingsParse({}),
        });
        nativeOpened = true;
        const original = new Client({ name: 'original-native-session', version: '1' });
        const resumed = new Client({ name: 'resumed-native-session', version: '1' });
        try {
            await original.connect(new StreamableHTTPClientTransport(new URL(server.url)));
            expect((await original.listTools()).tools.map(tool => tool.name)).toContain('action_execute');
            await original.close();
            (retirement === 'turn' ? turn : lifetime).abort();

            // Native session resume discovers tools before the next host turn is admitted.
            await resumed.connect(new StreamableHTTPClientTransport(new URL(server.url)));
            expect((await resumed.listTools()).tools.map(tool => tool.name)).toContain('action_execute');
            expect(await server.readToolNames()).toContain('action_execute');
            await expect(resumed.callTool({ name: 'action_spec_get', arguments: { id: 'browser.view.open' } })).rejects.toThrow();

            turn = new AbortController();
            lifetime = new AbortController();
            const result = await resumed.callTool({ name: 'action_spec_get', arguments: { id: 'browser.view.open' } });
            expect(result).toMatchObject({ isError: false, structuredContent: { actionSpec: { id: 'browser.view.open' } } });
            server.stop();
            await expect(server.readToolNames()).rejects.toThrow();
        } finally {
            await Promise.all([original.close(), resumed.close()]);
            server.stop();
        }
    });

    it('keeps a shared catalog read available to a surviving native tool when another caller cancels', async () => {
        daemonCatalogBoundary.read.mockReset();
        const host = new AbortController();
        const lifetime = new AbortController();
        const cancelledCaller = new AbortController();
        const survivingCaller = new AbortController();
        let enter: () => void = () => undefined;
        let release: () => void = () => undefined;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        let catalogReads = 0;
        let producerSignal: AbortSignal | undefined;
        daemonCatalogBoundary.read.mockImplementation(async (options?: Readonly<{ signal?: AbortSignal }>) => {
            catalogReads += 1;
            producerSignal = options?.signal;
            enter();
            return await new Promise((resolve, reject) => {
                release = () => resolve({ kind: 'available', plugins: [], tools: [] });
                options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
            });
        });
        const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'shared-catalog-session' }), {
            getRuntimeLifetimeSignal: () => lifetime.signal,
            getHostTurnAbortSignal: () => host.signal,
            getWorkDepth: () => 0,
            getActiveTurnPermissionWitness: () => ({ turnId: 'shared-catalog-turn', workDepth: 0,
                causalPermissionAuthority: { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const } }),
        });
        registerHappierSessionAgentToolRpc(session, {
            sessionCredentials: { token: 'shared-catalog-fixture', encryption: null }, accountSettings: accountSettingsParse({}),
        });
        const execute = (signal: AbortSignal) => session.rpcHandlerManager.invokeLocal(
            SESSION_RPC_METHODS.SESSION_AGENT_TOOL_CALL_V1,
            { toolName: 'action_spec_get', args: { id: 'browser.view.open' } }, { signal },
        );
        const cancelled = execute(cancelledCaller.signal);
        const surviving = execute(survivingCaller.signal);
        try {
            await entered;
            cancelledCaller.abort();
            await expect(cancelled).resolves.toMatchObject({ ok: false, errorCode: 'cancelled' });
            expect(host.signal.aborted).toBe(false);
            expect(survivingCaller.signal.aborted).toBe(false);
            expect(producerSignal).toBeDefined();
            expect(producerSignal?.aborted).toBe(false);
            release();
            await expect(surviving).resolves.toMatchObject({ ok: true, result: { actionSpec: { id: 'browser.view.open' } } });
            expect(catalogReads).toBe(1);
        } finally {
            release(); await Promise.allSettled([cancelled, surviving]);
        }
    });

    it('settles a tool cancelled by host Stop while its daemon catalog admission is pending', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValueOnce({ kind: 'available', plugins: [], tools: [] });
        const turn = new AbortController();
        const lifetime = new AbortController();
        let enter: (signal: AbortSignal | undefined) => void = () => undefined;
        let release: () => void = () => undefined;
        const entered = new Promise<AbortSignal | undefined>(resolve => { enter = resolve; });
        daemonCatalogBoundary.read.mockImplementation(async (options?: Readonly<{ signal?: AbortSignal }>) => {
            enter(options?.signal);
            return await new Promise((resolve, reject) => {
                release = () => resolve({ kind: 'available', plugins: [], tools: [] });
                options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
            });
        });
        const session = Object.assign(createMutableApiSessionClientFixture({ sessionId: 'catalog-stop-session' }), {
            getRuntimeLifetimeSignal: () => lifetime.signal,
            getHostTurnAbortSignal: () => turn.signal,
        });
        const server = await startHappyServer(session);
        const pending = fetch(server.url, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'action_execute', arguments: {
                actionId: 'browser.view.open', input: { kind: 'openView', commandId: 'catalog-stop',
                    browserSessionId: session.sessionId, viewId: 'view', platform: 'web',
                    target: { kind: 'externalUrl', targetId: 'target', url: 'https://example.test' } },
            } } }),
        });
        try {
            const signal = await Promise.race([entered, pending.then(async response => {
                throw new Error(`MCP request settled before catalog admission: ${await response.clone().text()}`);
            })]);
            expect(signal).toBeDefined();
            turn.abort();
            const response = await pending;
            expect(response.status).toBe(503);
            expect(await response.json()).toMatchObject({ ok: false, errorCode: 'cancelled' });
        } finally {
            release(); await pending; server.stop();
        }
    });

    it('refreshes the admitted inventory on policy, feature and contributor occurrence changes', async () => {
        vi.stubEnv('HAPPIER_ACTIONS_SETTINGS_V1', '');
        // Board reads also serve transcript visuals. Layout is the Action
        // whose canonical availability actually depends on sessions.board.
        const boardLayoutAction = 'session.board.layout.update' as const;
        const boardLayoutTool = getActionSpec(boardLayoutAction).bindings?.mcpToolName;
        let settings = accountSettingsParse({});
        let features: CliServerFeaturesSnapshot = { status: 'ready', features: FeaturesResponseSchema.parse({
            features: { sessions: { enabled: true, board: { enabled: true } } }, capabilities: {},
        }) };
        let tools: readonly ProjectedPluginToolCatalogEntry[] = [];
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockImplementation(async () => ({ kind: 'available', plugins: [], tools: structuredClone(tools) }));
        const session = createMutableApiSessionClientFixture({
            sessionId: 'inventory-refresh-session', overrides: {
                getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
                getServerFeaturesSnapshot: () => features,
            },
        });
        const server = await startHappyServer(session, {
            sessionCredentials: { token: 'offline-fixture', encryption: null },
            getAccountSettings: () => settings,
            requiredDirectActionIds: [boardLayoutAction],
        });
        const client = new Client({ name: 'inventory-refresh-test', version: '1.0.0' });
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(server.url)));
            const names = async () => (await client.listTools()).tools.map(tool => tool.name);
            expect(await names()).toContain('change_title');
            expect(await names()).toContain(boardLayoutTool);
            vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', 'sessions.board');
            expect(await names()).not.toContain(boardLayoutTool);
            vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
            expect(await names()).toContain(boardLayoutTool);
            // Supply the reader's effective policy rather than exercise a
            // persisted Settings migration in this inventory regression.
            settings = { ...settings, actionsSettingsV1: ActionsSettingsV1Schema.parse({
                v: 1, actions: { 'session.title.set': { enabled: false } },
            }) };
            expect(await names()).not.toContain('change_title');
            features = { status: 'ready', features: FeaturesResponseSchema.parse({ features: {}, capabilities: {} }) };
            expect(await names()).not.toContain(boardLayoutTool);
            settings = accountSettingsParse({});
            expect(await names()).toContain('change_title');
            tools = [{ toolId: 'acme.plugin/read', actionId: formatQualifiedPluginActionId({ pluginId: 'acme.plugin', localId: 'read-action' }), name: 'plugin_read',
                title: 'Plugin read', description: 'Read', inputSchema: { type: 'object', properties: {} },
                surfaces: ['agent'], expectedContributorOccurrenceId: 'occurrence-one' }];
            expect(await names()).toContain('plugin_read');
            tools = tools.map(tool => ({ ...tool, name: 'replacement_read', expectedContributorOccurrenceId: 'occurrence-two' }));
            expect(await names()).not.toContain('plugin_read');
            expect(await names()).toContain('replacement_read');
            tools = [];
            expect(await names()).not.toContain('replacement_read');
        } finally {
            vi.unstubAllEnvs();
            await client.close();
            server.stop();
        }
    });
    it('keeps notifications available during catalog loss while tool requests fail closed', async () => {
        daemonCatalogBoundary.read.mockReset();
        daemonCatalogBoundary.read.mockResolvedValueOnce({ kind: 'available', plugins: [], tools: [] });
        daemonCatalogBoundary.read.mockResolvedValue({ kind: 'unavailable', code: 'daemon_unavailable' });

        const client = createMutableApiSessionClientFixture({
            sessionId: 'notification-stream-session',
            overrides: {
                getServerBinding: () => ({ serverId: 'test-home', serverUrl: 'https://test-home.example.test' }),
            },
        });
        const server = await startHappyServer(client);
        const notificationStream = new AbortController();
        try {
            const response = await fetch(server.url, {
                headers: { Accept: 'text/event-stream' },
                signal: notificationStream.signal,
            });
            expect(response.status).toBe(200);
            expect(response.headers.get('content-type')).toContain('text/event-stream');
            notificationStream.abort();

            const toolResponse = await fetch(server.url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
            });
            expect(toolResponse.status).toBe(503);
            await expect(toolResponse.json()).resolves.toMatchObject({
                ok: false, errorCode: 'daemon_plugin_catalog_unavailable',
            });
        } finally {
            notificationStream.abort();
            server.stop();
        }
    });
});
