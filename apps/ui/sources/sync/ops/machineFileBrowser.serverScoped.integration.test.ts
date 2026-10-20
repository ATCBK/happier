import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { RPC_ERROR_CODES, RPC_ERROR_MESSAGES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// Only socket/HTTP transport and device credential storage are replaced. Home
// admission, routing, response decoding and the file-browser owners stay real.
const boundary = await installSessionOpsNetworkBoundary();
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { machineFilesystemListRoots, machineFilesystemListDirectory } = await import('./machineFileBrowser');
const { resolveFilesystemErrorReason } = await import('@/components/ui/filesystemBrowser/filesystemErrorReason');
const { t } = await import('@/text');
let home: Awaited<ReturnType<typeof boundary.addHome>>;

beforeEach(async () => {
    boundary.resetRequests();
    resetScopedMachineTransportCacheForTests();
    home = await boundary.addHome('https://filesystem.example.test', 'account-a');
    boundary.setHttpResponder(async input => new URL(String(input)).pathname === '/v1/account/encryption'
        ? Response.json({ mode: 'plain', updatedAt: 1 }) : null);
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});
afterAll(() => boundary.dispose());

const listings = [
    ['roots', (serverId: string) => machineFilesystemListRoots('machine-1', { serverId, accountId: 'account-a' })],
    ['directory', (serverId: string) => machineFilesystemListDirectory('machine-1', {
        path: '/home/happier/happier-dev', includeFiles: false,
    }, { serverId, accountId: 'account-a' })],
] as const;

describe('file-browser failures across the scoped network boundary', () => {
    it('retires a stuck tree read on disable and loads again when reopened', async () => {
        const { useWorkspaceRepositoryTreeBrowser } = await import('@/hooks/workspaces/files/useWorkspaceRepositoryTreeBrowser');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        boundary.setRpcResponder(async () => new Promise(() => {}));
        const scope = { serverId: home.id, machineId: 'machine-1', rootPath: '/tree-lifetime' };
        const hook = await renderHook(({ enabled }) => useWorkspaceRepositoryTreeBrowser({ scope, enabled }), {
            initialProps: { enabled: true },
        });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
        expect(hook.getCurrent().rootLoading).toBe(true);
        await hook.rerender({ enabled: false });
        await vi.waitFor(() => expect(boundary.socketBoundaries.some(({ socket }) =>
            socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(true));
        expect(hook.getCurrent().rootLoading).toBe(false);
        boundary.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
            return socketRpcCodec.encodeResponse({ mode: 'plain' }, { ok: true, path: scope.rootPath,
                entries: [{ name: 'ready.ts', path: `${scope.rootPath}/ready.ts`, type: 'file' }], truncated: false }, decoded.callId);
        });
        await hook.rerender({ enabled: true });
        await vi.waitFor(() => expect(hook.getCurrent().nodes.map(node => node.path)).toEqual(['ready.ts']));
        await hook.unmount();
    });

    it('keeps a shared warm read for another browser and retires it when the last browser leaves', async () => {
        const { warmMachineFileBrowserDirectoryCache } = await import('@/sync/domains/input/machineFileBrowser');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        boundary.setRpcResponder(async () => new Promise(() => {}));
        const first = new AbortController();
        const second = new AbortController();
        const input = { machineId: 'machine-1', serverId: home.id, directoryPath: '/warm-lifetime', includeFiles: true };
        let firstRetired = false;
        let secondRetired = false;
        const a = warmMachineFileBrowserDirectoryCache({ ...input, signal: first.signal }).catch(() => { firstRetired = true; });
        const b = warmMachineFileBrowserDirectoryCache({ ...input, signal: second.signal }).catch(() => { secondRetired = true; });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
        first.abort();
        await vi.waitFor(() => expect(firstRetired).toBe(true));
        expect(secondRetired).toBe(false);
        expect(boundary.socketBoundaries.some(({ socket }) => socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(false);
        second.abort();
        await vi.waitFor(() => expect(secondRetired).toBe(true));
        expect(boundary.socketBoundaries.some(({ socket }) => socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(true);
        await Promise.all([a, b]);
        boundary.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
            return socketRpcCodec.encodeResponse({ mode: 'plain' }, { ok: true, path: input.directoryPath,
                entries: [], truncated: false }, decoded.callId);
        });
        expect(await warmMachineFileBrowserDirectoryCache(input)).toEqual({ ok: true, entries: [], truncated: false });
        expect(boundary.requests).toHaveLength(2);
    });

    it('retires a terminal stream observation without closing the live terminal', async () => {
        const { createMachineRpcTerminalStreamCarrier } = await import('@/sync/domains/terminal/stream/carrier');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        const controller = new AbortController();
        boundary.setRpcResponder(async () => new Promise(() => {}));
        const carrier = createMachineRpcTerminalStreamCarrier({ machineId: 'machine-1', serverId: home.id, signal: controller.signal });
        let retired = false;
        const read = carrier.read({ terminalId: 'term-1', cursor: { mode: 'byte-offset', value: 0 } }).catch(() => { retired = true; });
        await vi.waitFor(() => expect(boundary.requests).toHaveLength(1));
        await act(async () => controller.abort());
        await vi.waitFor(() => expect(retired).toBe(true));
        expect(boundary.socketBoundaries.some(({ socket }) => socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(true);
        expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES]);
        await read;
    });

    it('retires the mounted terminal read when its view leaves', async () => {
        const { useMachineTerminalSession } = await import('@/hooks/machine/useMachineTerminalSession');
        const { SOCKET_RPC_EVENTS } = await import('@happier-dev/protocol/socketRpc');
        boundary.setRpcResponder(async () => new Promise(() => {}));
        const terminalRef = { current: { write: () => {}, clear: () => {} } };
        const hook = await renderHook(() => useMachineTerminalSession({ machineId: 'machine-1',
            serverId: home.id, cwd: null, terminalKey: 'borrowed-lifetime', terminalRef, attachedTerminalId: 'term-1',
            readOnly: true, closeOnUnmount: true }));
        // This Home does not advertise byte streaming, so the mounted owner
        // uses its supported legacy stream; cancellation applies to both.
        await vi.waitFor(() => expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_TERMINAL_STREAM_READ]));
        await hook.unmount();
        await vi.waitFor(() => expect(boundary.socketBoundaries.some(({ socket }) =>
            socket.emit.mock.calls.some(([event]) => event === SOCKET_RPC_EVENTS.CANCEL))).toBe(true));
        expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_TERMINAL_STREAM_READ]);
    });

    it.each(listings)('lists %s on the selected Home with unavailable features', async (_name, list) => {
        boundary.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
            const result = request.method === RPC_METHODS.DAEMON_FILESYSTEM_LIST_ROOTS
                ? { ok: true, roots: [{ id: '/', label: '/', path: '/' }] }
                : { ok: true, path: '/home/happier/happier-dev', entries: [], truncated: false };
            return await socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId);
        });
        expect(await list(home.id)).toMatchObject({ ok: true });
        expect(boundary.requests).toContainEqual(expect.objectContaining({ serverUrl: home.serverUrl, targetId: 'machine-1' }));
    });

    it.each(listings)('does not disguise the live server ReferenceError as a missing %s method', async (_name, list) => {
        boundary.setRpcAckResponder(async () => ({ ok: false, error: 'verifiedWorkspaceSyncTargetContinuation is not defined' }));
        const result = await list(home.id);
        expect(boundary.requests.length).toBeGreaterThan(0);
        expect(result).toEqual({ ok: false, error: 'MACHINE_RPC_FAILED', errorCode: 'MACHINE_RPC_FAILED' });
        if (!result.ok) expect(resolveFilesystemErrorReason(result.error)).toBe(t('errors.operationFailed'));
    });

    it.each([
        [RPC_ERROR_CODES.FORBIDDEN, 'errors.permissionDenied'],
        [RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, 'errors.daemonUnavailableBody'],
        [RPC_ERROR_CODES.METHOD_NOT_FOUND, 'errors.operationFailed'],
    ] as const)('preserves the %s failure class without exposing server exception text', async (code, key) => {
        boundary.setRpcAckResponder(async () => ({ ok: false, error: 'private server internals', errorCode: code }));
        for (const [, list] of listings) {
            const result = await list(home.id);
            expect(boundary.requests.length).toBeGreaterThan(0);
            expect(result).toMatchObject({ ok: false, errorCode: code });
            if (result.ok) throw new Error('Expected listing refusal');
            expect(result.error).not.toContain('private server internals');
            expect(resolveFilesystemErrorReason(result.error)).toBe(t(key));
        }
        expect(resolveFilesystemErrorReason(RPC_ERROR_MESSAGES.METHOD_NOT_AVAILABLE)).toBe(t('errors.daemonUnavailableBody'));
    });

    it('distinguishes an acknowledgement timeout from unsupported methods', async () => {
        boundary.setRpcAckResponder(async () => { throw new Error('operation has timed out'); });
        const result = await machineFilesystemListRoots('machine-1', { serverId: home.id, timeoutMs: 1_000 });
        expect(result).toEqual({ ok: false, error: 'MACHINE_RPC_TIMEOUT', errorCode: 'MACHINE_RPC_TIMEOUT' });
        if (!result.ok) expect(resolveFilesystemErrorReason(result.error)).toBe(t('errors.connectionTimeout'));
    });

    it('classifies a failed socket connection as unreachable without disclosing its exception', async () => {
        boundary.setSocketConfigurator(({ socket, trigger }) => {
            socket.connect.mockImplementation(() => trigger('connect_error', new Error('private transport details')));
        });
        const result = await machineFilesystemListRoots('machine-1', { serverId: home.id });
        expect(result).toEqual({ ok: false, error: 'MACHINE_RPC_UNREACHABLE', errorCode: 'MACHINE_RPC_UNREACHABLE' });
        if (!result.ok) expect(resolveFilesystemErrorReason(result.error)).toBe(t('errors.networkError'));
    });

    it('preserves caller cancellation rather than presenting a listing failure', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(machineFilesystemListRoots('machine-1', { serverId: home.id, signal: controller.signal })).rejects.toThrow();
    });
});
