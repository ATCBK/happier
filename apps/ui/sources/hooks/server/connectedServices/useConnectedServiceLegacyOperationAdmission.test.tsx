import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { clearMachineRequestReachabilityForTest, recordMachineRequestFailed, recordMachineRequestSucceeded } from '@/sync/domains/machines/reachability/machineReachability';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import type { ConnectedAccountDaemonControlResponse, ConnectedAccountPeerOperationTransport } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';

const runControlMock = vi.hoisted(() => vi.fn());

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event: string, payload: SocketRpcRequestPayload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
        return { ok: true, result: await runControlMock(payload) };
    });
});
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let syncBridge: Awaited<ReturnType<typeof import('@/dev/testkit/harness/syncSingletonLoader')['loadSyncSingletonForTests']>>;

const github = { pluginId: 'happier.scm.forge.github', localId: 'github-account' };
const anthropic = { pluginId: 'happier.agent.claude', localId: 'anthropic' };
function described(service: PluginContributionIdentityV1, operationTransport: ConnectedAccountPeerOperationTransport): ConnectedAccountDaemonControlResponse {
    return { status: 'described', service,
        descriptor: { id: service.localId, title: 'Test Account', authentication: { defaultModeId: 'manual', modes: [{
            id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
            fields: [{ id: 'token', title: 'Token', schema: { type: 'string', minLength: 1 }, secret: true }],
        }] } },
        occurrenceId: 'occurrence-1', sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-1', installSource: 'archive' },
        accounts: [], operationTransport };
}

describe('useConnectedServiceLegacyOperationAdmission', () => {
    beforeEach(async () => {
        installHomeGovernanceBoundaries(homes);
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        syncBridge = await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Admission Home', serverUrl: 'https://account-admission.test', accountId: 'account-a' });
        for (const id of ['machine-a', 'machine-b']) homes.answer(serverId, `/v1/machines/${id}`, {
            body: { machine: createPlainMachineRowFixture({ id, accountId: 'account-a' }) },
        });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://account-admission.test', accountId: 'account-a', request: homes.request });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-a', activeAt: Date.now(), isShared: false })], true, { sourceServerId: serverId });
        clearMachineRequestReachabilityForTest();
        runControlMock.mockReset();
    });
    afterEach(async () => {
        await standardCleanup();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        await connection?.dispose();
        syncBridge?.dispose();
        await homes.reset();
        clearMachineRequestReachabilityForTest();
        vi.restoreAllMocks();
    });

    it('retires a stalled daemon admission on unmount and allows the next mounted owner to retry', async () => {
        const { useConnectedServiceLegacyOperationAdmission } = await import('./useConnectedServiceLegacyOperationAdmission');
        runControlMock.mockImplementationOnce(() => new Promise(() => {}));
        const first = await renderHook(() => useConnectedServiceLegacyOperationAdmission());
        let pendingStatus = 'pending';
        let failure: unknown;
        const pending = first.getCurrent()('github', 'quota_read');
        const settled = pending.then(() => { pendingStatus = 'resolved'; }, error => { pendingStatus = 'cancelled'; failure = error; });
        await vi.waitFor(() => expect(runControlMock).toHaveBeenCalledTimes(1));
        expect(runControlMock.mock.calls[0]?.[0]).toMatchObject({ method: 'machine-a:daemon.connectedAccounts.control.command' });
        expect(pendingStatus).toBe('pending');
        await first.unmount();
        await vi.waitFor(() => expect(pendingStatus).toBe('cancelled'));
        await settled;
        expect(failure).toMatchObject({ name: 'AbortError' });
        runControlMock.mockResolvedValue(described(github, { kind: 'legacy', peerClass: 'revisioned_v2_v3', serviceId: 'github' }));
        const second = await renderHook(() => useConnectedServiceLegacyOperationAdmission());
        await expect(second.getCurrent()('github', 'quota_read')).resolves.toBeUndefined();
    });

    it('moves automatic admission to reachable supply and rejects when no executable Machine remains', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { useConnectedServiceLegacyOperationAdmission } = await import('./useConnectedServiceLegacyOperationAdmission');
        storage.getState().applyMachines([
            createMachineFixture({ id: 'machine-a', activeAt: Date.now(), isShared: false }),
            createMachineFixture({ id: 'machine-b', activeAt: Date.now(), isShared: false }),
        ], true, { sourceServerId: serverId });
        const hook = await renderHook(() => useConnectedServiceLegacyOperationAdmission());
        await act(async () => { recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: 'machine-a' }); });
        runControlMock.mockResolvedValue(described(github, { kind: 'legacy', peerClass: 'revisioned_v2_v3', serviceId: 'github' }));
        await hook.getCurrent()('github', 'quota_read');
        expect(runControlMock.mock.calls.at(-1)?.[0].params.machineId).toBe('machine-b');
        await act(async () => { recordMachineRequestFailed({ serverId, accountId: 'account-a', machineId: 'machine-b' }); });
        await expect(hook.getCurrent()('github', 'quota_read')).rejects.toMatchObject({ code: 'connected_account_service_identity_unsupported' });
        await act(async () => { recordMachineRequestSucceeded({ serverId, accountId: 'account-a', machineId: 'machine-a' }); });
        await hook.getCurrent()('github', 'quota_read');
        expect(runControlMock.mock.calls.at(-1)?.[0].params.machineId).toBe('machine-a');
    });

    it('keeps Account operation discovery on an owned Machine and refuses shared or unproven custody', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { useConnectedServiceLegacyOperationAdmission } = await import('./useConnectedServiceLegacyOperationAdmission');
        const shared = createMachineFixture({ id: 'machine-a', activeAt: Date.now(), isShared: true,
            access: { custodian: { accountId: 'account-c', displayName: 'Custodian' },
                role: 'use', resourceMode: 'plain', accessState: 'ready' } });
        const own = createMachineFixture({ id: 'machine-b', activeAt: Date.now(), isShared: false });
        storage.getState().applyMachines([shared, own], true, { sourceServerId: serverId });
        runControlMock.mockResolvedValue(described(github, { kind: 'legacy', peerClass: 'revisioned_v2_v3', serviceId: 'github' }));
        const hook = await renderHook(() => useConnectedServiceLegacyOperationAdmission());

        await expect(hook.getCurrent()('github', 'quota_read')).resolves.toBeUndefined();
        expect(runControlMock.mock.calls.at(-1)?.[0]).toMatchObject({
            method: 'machine-b:daemon.connectedAccounts.control.command',
            params: { machineId: 'machine-b', command: { operation: 'describeService', requiredOperation: 'quota_read' } },
        });

        await act(async () => {
            storage.getState().applyMachines([shared,
                createMachineFixture({ id: 'machine-unproven', activeAt: Date.now() }),
            ], true, { sourceServerId: serverId });
        });
        runControlMock.mockClear();
        await expect(hook.getCurrent()('github', 'quota_read')).rejects.toMatchObject({
            code: 'connected_account_service_identity_unsupported',
        });
        expect(runControlMock).not.toHaveBeenCalled();
    });

    it('carries the qualified identity and requested operation to daemon admission', async () => {
        runControlMock.mockResolvedValue(described(github, { kind: 'legacy', peerClass: 'revisioned_v2_v3', serviceId: 'github' }));
        const { useConnectedServiceLegacyOperationAdmission } = await import(
            './useConnectedServiceLegacyOperationAdmission'
        );
        const hook = await renderHook(
            () => useConnectedServiceLegacyOperationAdmission(),
        );

        await act(async () => {
            await hook.getCurrent()('github', 'quota_refresh');
        });

        expect(runControlMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'machine-a:daemon.connectedAccounts.control.command',
            params: { v: 1, machineId: 'machine-a', command: {
                operation: 'describeService',
                service: {
                    pluginId: 'happier.scm.forge.github',
                    localId: 'github-account',
                },
                requiredOperation: 'quota_refresh',
            } },
        }));
        await standardCleanup();
    });

    it('rejects unsupported and non-legacy transports before a quota caller can issue network effects', async () => {
        runControlMock.mockResolvedValueOnce({
            status: 'unavailable',
            code: 'connected_account_service_identity_unsupported',
        });
        const { useConnectedServiceLegacyOperationAdmission } = await import(
            './useConnectedServiceLegacyOperationAdmission'
        );
        const hook = await renderHook(
            () => useConnectedServiceLegacyOperationAdmission(),
        );

        await expect(
            hook.getCurrent()('bitbucket', 'quota_read'),
        ).rejects.toMatchObject({
            code: 'connected_account_service_identity_unsupported',
        });
        runControlMock.mockResolvedValueOnce(described(github, { kind: 'v4' }));
        await expect(
            hook.getCurrent()('github', 'quota_read'),
        ).rejects.toMatchObject({
            code: 'connected_account_legacy_operation_unsupported',
        });
        await standardCleanup();
    });

    it('admits the exact qualified V4 service only when the daemon selects V4', async () => {
        runControlMock.mockResolvedValue(described(anthropic, { kind: 'v4' }));
        const { useConnectedAccountOperationAdmission } = await import(
            './useConnectedServiceLegacyOperationAdmission'
        );
        const hook = await renderHook(
            () => useConnectedAccountOperationAdmission(),
        );

        await act(async () => {
            await hook.getCurrent()(
                {
                    pluginId: 'happier.agent.claude',
                    localId: 'anthropic',
                },
                { kind: 'v4' },
                'quota_read',
            );
        });

        expect(runControlMock).toHaveBeenCalledWith(expect.objectContaining({
            method: 'machine-a:daemon.connectedAccounts.control.command',
            params: { v: 1, machineId: 'machine-a', command: {
                operation: 'describeService',
                service: {
                    pluginId: 'happier.agent.claude',
                    localId: 'anthropic',
                },
                requiredOperation: 'quota_read',
            } },
        }));
        await standardCleanup();
    });

    it('rejects a contradictory exact-old daemon transport for a V4 operation', async () => {
        runControlMock.mockResolvedValue(described(anthropic, { kind: 'legacy', peerClass: 'exact_v0_2_1', serviceId: 'anthropic' }));
        const { useConnectedAccountOperationAdmission } = await import(
            './useConnectedServiceLegacyOperationAdmission'
        );
        const hook = await renderHook(
            () => useConnectedAccountOperationAdmission(),
        );

        await expect(hook.getCurrent()(
            {
                pluginId: 'happier.agent.claude',
                localId: 'anthropic',
            },
            { kind: 'v4' },
            'quota_read',
        )).rejects.toMatchObject({
            code: 'connected_account_v4_operation_unsupported',
        });
        await standardCleanup();
    });
});
