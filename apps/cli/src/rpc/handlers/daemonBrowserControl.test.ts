import { FeaturesResponseSchema, type BrowserCommandV1, type BrowserCommandDispatchResultV1, type BrowserEventV1, type BrowserDaemonViewV1 } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { createBrowserDaemonControlBroker } from '@/daemon/browser/control/broker';
import { createBrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber } from '@/daemon/browser/sidecar/controlAdapter';
import { createBrowserDaemonRuntimeActionExecutor } from '@/daemon/browser/actions/runtimeActionExecutor';
import { createBrowserDaemonFeatureGate } from '@/daemon/browser/featureGate';
import { registerDaemonBrowserControlHandler } from './daemonBrowserControl';

// Static CLI imports also load Socket.IO; install the canonical external boundary first.
vi.mock('socket.io-client', async (importOriginal) => {
    const path = new URL('../../../../ui/sources/dev/testkit/harness/serverAccountConnectionHarness.ts', import.meta.url).href;
    return (await import(path)).createSocketIoClientBoundary(importOriginal);
});

const MACHINE_ID = 'machine_browser_control';
const BROWSER_SESSION_ID = 'browser_session_1';
const VIEW_ID = 'view_1';
const uiPath = (path: string) => new URL(`../../../../ui/sources/${path}`, import.meta.url).href;

// Runtime imports preserve package alias ownership without adding UI roots to CLI compilation.
const { installSessionActionRpcBoundary }: {
    installSessionActionRpcBoundary(respond: (request: SocketRpcRequestPayload) => unknown): SocketRpcRequestPayload[];
} = await import(uiPath('dev/testkit/harness/sessionActionRpcBoundary.ts'));
const { serveAccountHomes }: {
    serveAccountHomes(params: { homes: { key: string; serverUrl: string; accountId: string }[];
        route(request: { path: string }): Response | undefined }): Promise<{
            homes: Record<string, { id: string }>; dispose(): void;
        }>;
} = await import(uiPath('dev/testkit/harness/actionHomesHttpHarness.ts'));
const { createPlainMachineRowFixture }: {
    createPlainMachineRowFixture(input: { id: string; accountId: string }): unknown;
} = await import(uiPath('dev/testkit/fixtures/machineFixtures.ts'));

// Compile the cross-package UI graph during collection, outside the behavior deadline.
// Install the external relay before importing consumers; its delegate reads the current real RPC owner.
vi.stubGlobal('__DEV__', true);
vi.stubGlobal('self', globalThis);
const { installVitestRnShim }: { installVitestRnShim(): void } = await import(uiPath('dev/vitestRnShim.ts'));
installVitestRnShim();
let activeRpc: RpcHandlerManager | undefined;
installSessionActionRpcBoundary(request => {
    if (!request.method.startsWith(`${MACHINE_ID}:`)) throw new Error('RPC reached the wrong Machine');
    if (!activeRpc) throw new Error('Browser test RPC owner is unavailable');
    return activeRpc.invokeLocal(request.method.slice(MACHINE_ID.length + 1), request.params);
});
await Promise.all([
    import(uiPath('sync/domains/server/serverRuntime.ts')),
    import(uiPath('auth/storage/tokenStorage.ts')),
    import(uiPath('utils/system/runtimeFetch.ts')),
    import(uiPath('sync/domains/state/storage.ts')),
]);
const { createBrowserDaemonControlCommandSender, listBrowserDaemonViewsViaMachineRpc }: {
    createBrowserDaemonControlCommandSender(input: { machineId: string; serverId: string }):
        (command: BrowserCommandV1, onEvents?: (events: readonly BrowserEventV1[]) => void) =>
            Promise<{ ok: true; result: BrowserCommandDispatchResultV1 } | { ok: false; reason: string }>;
    listBrowserDaemonViewsViaMachineRpc(input: { machineId: string; serverId: string; browserSessionId: string }):
        Promise<{ ok: true; views: readonly BrowserDaemonViewV1[] } | { ok: false; reason: string }>;
} = await import(uiPath('sync/domains/browser/control/machineRpc.ts'));
const { serverScopedRpcSocketPool }: { serverScopedRpcSocketPool: { stopAll(): Promise<void> } } =
    await import(uiPath('sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool.ts'));

function createRuntime() {
    const pageCommands: string[] = [];
    let notify: BrowserSidecarCdpEventSubscriber | undefined;
    const adapter = createBrowserSidecarCdpControlAdapter({
        browserSessionId: BROWSER_SESSION_ID, sidecarId: 'sidecar_browser_control',
        // Chromium CDP is the OS/network boundary. Bindings, events and dispatch stay real.
        transport: {
            openPage: async () => ({ targetId: 'target_browser_control', sessionId: 'cdp_browser_control' }),
            dispatchPageCommand: async ({ method, params }) => {
                pageCommands.push(method);
                if (method === 'Page.navigate') notify?.({ method: 'Page.frameNavigated', sessionId: 'cdp_browser_control',
                    params: { frame: { id: 'frame', loaderId: 'document_next', url: params?.url } } });
                return method === 'Page.getFrameTree'
                    ? { frameTree: { frame: { id: 'frame', loaderId: 'document', url: 'https://browser.example.test/' } } }
                    : {};
            },
            dispatchBrowserCommand: async () => ({ success: true }),
            subscribeCdpEvents: listener => { notify = listener; return () => { notify = undefined; }; },
        },
    });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(adapter);
    const routes = createBrowserDaemonControlRoutes({ broker });
    const featureGate = createBrowserDaemonFeatureGate({ env: { NODE_ENV: 'test' },
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({
            features: { browser: { enabled: true, viewTargets: { enabled: true },
                internal: { enabled: true }, sidecar: { enabled: true } } },
        }) }) });
    const execute = createBrowserDaemonRuntimeActionExecutor({ control: routes, featureGate });
    const rpc = new RpcHandlerManager({ scopePrefix: MACHINE_ID, encryptionMode: 'plain', logger: () => {} });
    registerDaemonBrowserControlHandler(rpc, { browserControl: routes });
    return { adapter, rpc, pageCommands, execute, featureGate };
}

afterEach(() => { activeRpc = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('daemon Browser control UI seam', () => {
    it('opens and reloads the sidecar through real UI machine RPC, discovers its strict output and reports an unowned view', async () => {
        const runtime = createRuntime();
        activeRpc = runtime.rpc;
        await runtime.featureGate.refresh();
        const machine = createPlainMachineRowFixture({ id: MACHINE_ID, accountId: 'browser-account' });
        const homes = await serveAccountHomes({ homes: [{ key: 'browser', serverUrl: 'https://browser-control.example.test',
            accountId: 'browser-account' }], route: request => request.path === `/v1/machines/${MACHINE_ID}`
                ? Response.json({ machine }) : undefined });
        try {
            const scope = { machineId: MACHINE_ID, serverId: homes.homes.browser.id };
            const send = createBrowserDaemonControlCommandSender(scope);
            const events: BrowserEventV1[] = [];
            expect(await send({ kind: 'openView', commandId: 'open', browserSessionId: BROWSER_SESSION_ID,
                viewId: VIEW_ID, platform: 'web', target: { kind: 'externalUrl', targetId: 'external',
                    url: 'https://browser.example.test/' } }, incoming => events.push(...incoming)))
                .toMatchObject({ ok: true, result: { status: 'dispatched', adapterKind: 'chromiumSidecar' } });
            expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ viewId: VIEW_ID,
                currentUrl: 'https://browser.example.test/' })]));
            expect(await runtime.execute({ actionId: 'browser.navigate', context: { defaultSessionId: BROWSER_SESSION_ID },
                input: { kind: 'navigate', commandId: 'action_navigate', browserSessionId: BROWSER_SESSION_ID,
                    viewId: VIEW_ID, url: 'https://browser.example.test/next' } }))
                .toMatchObject({ commandId: 'action_navigate', status: 'dispatched' });
            expect(await listBrowserDaemonViewsViaMachineRpc({ ...scope, browserSessionId: BROWSER_SESSION_ID }))
                .toMatchObject({ ok: true, views: [{ browserSessionId: BROWSER_SESSION_ID, viewId: VIEW_ID,
                    adapterKind: 'chromiumSidecar', events: [expect.objectContaining({
                        currentUrl: 'https://browser.example.test/next',
                    })] }] });
            expect(await send({ kind: 'reload', commandId: 'reload', browserSessionId: BROWSER_SESSION_ID, viewId: VIEW_ID }))
                .toMatchObject({ ok: true, result: { commandId: 'reload', status: 'dispatched' } });
            expect(runtime.pageCommands).toContain('Page.reload');
            expect(await send({ kind: 'stop', commandId: 'stop', browserSessionId: BROWSER_SESSION_ID, viewId: 'unowned' }))
                .toMatchObject({ ok: true, result: { status: 'failed', error: { code: 'view_not_found' } } });
        } finally {
            try {
                await serverScopedRpcSocketPool.stopAll();
            } finally { homes.dispose(); runtime.adapter.dispose(); }
        }
    });

    it('rejects malformed RPC commands without touching Chromium and reports an unwired runtime', async () => {
        const runtime = createRuntime();
        try {
            await expect(runtime.rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
                { machineId: MACHINE_ID, command: { kind: 'reload' } })).rejects.toThrow();
            expect(runtime.pageCommands).toEqual([]);
            const unavailable = new RpcHandlerManager({ scopePrefix: MACHINE_ID, encryptionMode: 'plain', logger: () => {} });
            registerDaemonBrowserControlHandler(unavailable, { browserControl: null });
            await expect(unavailable.invokeLocal(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
                { machineId: MACHINE_ID, command: { kind: 'reload', commandId: 'reload',
                    browserSessionId: BROWSER_SESSION_ID, viewId: VIEW_ID } })).rejects.toThrow('Browser control runtime is unavailable');
        } finally { runtime.adapter.dispose(); }
    });
});
