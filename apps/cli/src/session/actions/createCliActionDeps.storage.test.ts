import { afterEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { HappierStorageSummaryV1Schema } from '@happier-dev/protocol/storage/storageV1';
import { createCliActionDeps } from './createCliActionDeps';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { RpcHandlerMap, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createDaemonStorageRoutes, registerDaemonStorageRpcHandlers } from '@/rpc/handlers/storage';

afterEach(() => vi.restoreAllMocks());
describe('CLI storage Action transport', () => {
    it('retains an accepted cleanup acknowledgement after caller cancellation while retired reads remain closed', async () => {
        const transport = await import('@/session/transport/rpc/machineRpc');
        const controller = new AbortController();
        const receipt = { batchId: 'batch', mode: 'trash', outcomes: [{ itemId: 'cache', status: 'moved' }], inTrashBytes: 4096, freedBytes: 0 };
        // Only the authenticated daemon transport is replaced, including its consumed acknowledgement.
        const rpc = vi.spyOn(transport, 'callExactMachineRpc').mockImplementation(async () => { controller.abort(); return receipt; });
        const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', serverId: 'home',
            serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null });
        const context = { surface: 'cli' as const, authority: 'present_user' as const, serverId: 'home' };
        const ref = { itemId: 'cache', path: '/cache', identity: { dev: '1', ino: '2', kind: 'directory' as const },
            collectedAt: 1, collectedBy: { accountId: 'owner', kind: 'person' as const } };
        await expect(deps.machineStorageAction!({ actionId: 'machines.storage.trash.move',
            input: { machineId: 'selected-machine', items: [{ ref, expect: 'checked', claimedVerdict: 'safe' }] }, context, signal: controller.signal }))
            .resolves.toEqual(receipt);
        const readController = new AbortController();
        rpc.mockImplementationOnce(async () => {
            readController.abort();
            return { revision: 1, sizedAt: 1, volumes: [], categories: [], suggestionsTop: [],
                pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } };
        });
        await expect(deps.machineStorageAction!({ actionId: 'machines.storage.summary.get',
            input: { machineId: 'selected-machine' }, context, signal: readController.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
    });
    it('preserves a typed daemon rejection instead of misclassifying it as invalid Action output', async () => {
        const transport = await import('@/session/transport/rpc/machineRpc');
        // The daemon RPC error response is the actual transport boundary shape.
        vi.spyOn(transport, 'callExactMachineRpc').mockResolvedValue({ error: 'Storage item cannot be collected', errorCode: 'storage_item_not_collectable' });
        const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        const executor = createActionExecutor(createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', serverId: 'home',
            serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null }));
        expect(await executor.execute('machines.storage.pile.set', { machineId: 'selected-machine',
            add: [{ itemId: 'invented-id', path: '/scanned/file' }] }, { surface: 'cli', authority: 'present_user', serverId: 'home' }))
            .toEqual({ ok: false, errorCode: 'storage_item_not_collectable', error: 'Storage item cannot be collected' });
    });
    it('reads the selected machine through canonical Machine RPC and preserves target and cancellation', async () => {
        const transport = await import('@/session/transport/rpc/machineRpc');
        const summary = HappierStorageSummaryV1Schema.parse({ revision: 1, sizedAt: 100, volumes: [], categories: [], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } });
        // Network transport is the boundary; Action routing and input admission remain real.
        const rpc = vi.spyOn(transport, 'callExactMachineRpc').mockResolvedValue(summary);
        const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', serverId: 'home',
            serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null });
        const signal = new AbortController().signal;
        await expect(deps.machineStorageAction!({ actionId: 'machines.storage.summary.get', input: { machineId: 'selected-machine' },
            context: { surface: 'cli', authority: 'present_user', serverId: 'home' }, signal })).resolves.toEqual(summary);
        expect(rpc).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'selected-machine', method: RPC_METHODS.DAEMON_STORAGE_SUMMARY_GET,
            request: { machineId: 'selected-machine', serverId: 'home' }, signal }));
    });
    it('uses authenticated exact-machine ingress when a local target transport has no Machine admission', async () => {
        const transport = await import('@/session/transport/rpc/machineRpc');
        const summary = HappierStorageSummaryV1Schema.parse({ revision: 1, sizedAt: 100, volumes: [], categories: [], suggestionsTop: [],
            pile: { count: 0, freesBytes: 0, droppedSinceLastView: [] }, trash: { count: 0, allocatedBytes: 0 }, wholeDisk: { enabled: false, scans: [] } });
        // Exact-machine network ingress is the controlled boundary; the Action and local RPC handler remain real.
        const authenticatedRpc = vi.spyOn(transport, 'callExactMachineRpc').mockResolvedValue(summary);
        // Use the canonical untyped transport map; handlers retain their real schema admission.
        const handlers: RpcHandlerMap = new Map();
        const rpc: RpcHandlerRegistrar = { registerHandler(method, handler) { handlers.set(method, handler); } };
        const routes = createDaemonStorageRoutes({ target: () => ({ serverId: 'home', machineId: 'selected-machine',
            installationId: 'install', custodianAccountId: 'owner' }), deps: () => ({
            catalog: { happyHomeDir: '/missing-fixture', activeServerDir: '/missing-fixture/server' }, readVolumes: () => [] }),
            readOwnSessionIds: () => new Set() });
        registerDaemonStorageRpcHandlers(rpc, routes);
        try {
            const credentials = { token: 'token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
            const deps = createCliActionDeps({ token: 'token', credentials, sessionId: 'cli-global', serverId: 'home',
                serverHttpBaseUrl: 'https://home.example.test', mode: 'plain', ctx: null,
                machineActionDirectTargetTransport: { machineId: 'selected-machine', invoke: async (method, request) => handlers.get(method)!(request) } });
            expect(await createActionExecutor(deps).execute('machines.storage.summary.get', { machineId: 'selected-machine' },
                { surface: 'cli', authority: 'present_user', serverId: 'home' })).toEqual({ ok: true, result: summary });
            const scan = { state: null, nodes: [], coverage: [] };
            authenticatedRpc.mockResolvedValueOnce(scan);
            expect(await createActionExecutor(deps).execute('machines.storage.scan.get', { machineId: 'selected-machine' },
                { surface: 'cli', authority: 'present_user', serverId: 'home' })).toEqual({ ok: true, result: scan });
            expect(authenticatedRpc).toHaveBeenLastCalledWith(expect.objectContaining({ method: RPC_METHODS.DAEMON_STORAGE_SCAN_GET,
                machineId: 'selected-machine', request: { machineId: 'selected-machine', serverId: 'home' } }));
        } finally { routes.dispose(); }
    });
});
