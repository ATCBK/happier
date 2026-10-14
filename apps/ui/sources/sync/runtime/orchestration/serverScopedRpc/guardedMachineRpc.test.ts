import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// Only HTTP, Socket.IO and device credential persistence are replaced. Policy,
// target selection and the coordinator execute through their canonical owners.
const boundary = await installSessionOpsNetworkBoundary();
const { callGuardedMachineRpcWithPolicy, isGuardedMachineRpcMethod, resolveTransferPolicyAllowsMachineRpcDirect } = await import('./guardedMachineRpc');
const { serverScopedRpcSocketPool } = await import('./serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('./serverScopedRpcPool');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } = await import('../appliedActiveServerRuntime');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { readRpcRequestDisposition } = await import('@happier-dev/sync-client');
let home: Awaited<ReturnType<typeof boundary.addHome>>;

function respondFeatures(enabled: boolean): void {
    boundary.setHttpResponder(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path !== '/v1/features') return null;
        return Response.json(createRootLayoutFeaturesResponse({ features: { machines: { transfer: {
            enabled, directPeer: { enabled: true }, serverRouted: { enabled: true },
        } } } }));
    });
}

afterEach(async () => {
    vi.useRealTimers();
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});
afterAll(() => boundary.dispose());

describe('guardedMachineRpc', () => {
    beforeEach(async () => {
        boundary.resetRequests();
        resetServerFeaturesClientForTests();
        resetScopedMachineTransportCacheForTests();
        home = await boundary.addHome('https://guarded-scenarios.example.test', 'account-a');
        respondFeatures(true);
        boundary.respond(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, { ok: true });
    });

    it('recognizes guarded methods', () => {
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT)).toBe(true);
        for (const method of [
            'daemon.promptRegistry.download.init',
            'daemon.promptRegistry.download.chunk',
            'daemon.promptRegistry.download.finalize',
            'daemon.promptRegistry.download.abort',
        ]) {
            expect(isGuardedMachineRpcMethod(method)).toBe(true);
        }
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_ABORT)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE)).toBe(true);
        expect(isGuardedMachineRpcMethod('daemon.filesystem.upload')).toBe(true);
        expect(isGuardedMachineRpcMethod('daemon.filesystem.download')).toBe(true);
        expect(isGuardedMachineRpcMethod('daemon.filesystem.transfer.cancel')).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ)).toBe(true);
        expect(isGuardedMachineRpcMethod(RPC_METHODS.LIST_DIRECTORY)).toBe(false);
        expect(isGuardedMachineRpcMethod('ripgrep')).toBe(false);
        expect(isGuardedMachineRpcMethod('daemon.bulkTransfer.start')).toBe(false);
        expect(isGuardedMachineRpcMethod('daemon.ping')).toBe(false);
    });

    it('fails closed when server features are unavailable', async () => {
        boundary.setHttpResponder(async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/features') return Response.json({}, { status: 404 });
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            return null;
        });
        await expect(resolveTransferPolicyAllowsMachineRpcDirect({ serverId: home.id, timeoutMs: 1_000 })).resolves.toBe(false);
        await expect(callGuardedMachineRpcWithPolicy({
            machineId: 'm1', serverId: home.id, accountId: home.accountId,
            method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT, payload: { kind: 'prompt-assets', id: 'asset-a' },
        })).resolves.toEqual({ ok: true });
        expect(boundary.requests[0]).toMatchObject({ serverUrl: home.serverUrl, targetId: 'm1' });
    });

    it('evaluates an omitted guarded target against the applied Home, not the staged Home', async () => {
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const previousActive = getActiveServerSnapshot();
        const staged = await boundary.addHome('https://staged-guarded-home.example.test', 'account-b');
        try {
            publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 }, false);
            await setActiveServerId(staged.id);
            await expect(callGuardedMachineRpcWithPolicy({
                machineId: 'm-shared', method: RPC_METHODS.DAEMON_PROMPT_ASSETS_DOWNLOAD_INIT,
                payload: { kind: 'prompt-assets', id: 'asset-a' },
            })).resolves.toEqual({ ok: true });
            expect(boundary.requests[0]).toMatchObject({ serverUrl: home.serverUrl, targetId: 'm-shared' });
            expect(boundary.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/features'))
                .toEqual([expect.objectContaining({ url: home.serverUrl + '/v1/features' })]);
        } finally {
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
            await setActiveServerId(previousActive.serverId);
        }
    });

    it('allows direct route when transfer is enabled', async () => {
        await expect(resolveTransferPolicyAllowsMachineRpcDirect({ serverId: home.id, timeoutMs: 1_000 })).resolves.toBe(true);
    });

    it('fails closed when transfer is disabled', async () => {
        respondFeatures(false);
        await expect(resolveTransferPolicyAllowsMachineRpcDirect({ serverId: home.id, timeoutMs: 1_000 })).resolves.toBe(false);
    });

    it('fails closed when transfer discovery fails at the HTTP boundary', async () => {
        boundary.setHttpResponder(async () => { throw new TypeError('Network connection lost'); });
        await expect(resolveTransferPolicyAllowsMachineRpcDirect({ serverId: home.id, timeoutMs: 1_000 })).resolves.toBe(false);
    });

    it('does not consult transfer policy for non-guarded methods', async () => {
        boundary.respond('daemon.ping', { ok: true });
        await expect(callGuardedMachineRpcWithPolicy({
            machineId: 'm1', serverId: home.id, method: 'daemon.ping', payload: undefined,
        })).resolves.toEqual({ ok: true });
        expect(boundary.httpRequests.filter(({ url }) => new URL(url).pathname === '/v1/features')).toHaveLength(0);
        expect(boundary.requests[0]).toMatchObject({ method: 'daemon.ping' });
    });

    it('cancels an issued guarded call through the coordinator while preserving possible effects', async () => {
        const issued = createDeferred<void>();
        const reply = createDeferred<void>();
        boundary.setRpcAckResponder(async () => {
            issued.resolve();
            await reply.promise;
            return { ok: true, result: { ok: true } };
        });
        const controller = new AbortController();
        const pending = callGuardedMachineRpcWithPolicy({
            machineId: 'm1', serverId: home.id, method: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE,
            payload: { t: 'session_file_upload_v1' }, signal: controller.signal,
        }).catch((error: unknown) => error);
        try {
            await issued.promise;
            controller.abort();
            const error = await pending;
            expect(error).toMatchObject({ code: 'MACHINE_RPC_ABORTED' });
            expect(readRpcRequestDisposition(error)).toBe('outcomeUnknown');
            expect(boundary.requests).toHaveLength(1);
        } finally {
            reply.resolve();
        }
    });
});
