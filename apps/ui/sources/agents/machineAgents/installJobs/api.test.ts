import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});

import { startAgentInstallJobRpc } from './api';

describe('agent install job RPC boundary', () => {
    it('reports operation unavailability for canonical missing-method responses and errors without trying a legacy mutation', async () => {
        const target = { machineId: 'machine', serverId: 'server' };
        const request = { agentId: 'codex', intent: 'install', consent: { vendorRecipe: true } } as const;
        boundary.rpc.mockRejectedValueOnce(new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND));
        await expect(startAgentInstallJobRpc(target, request)).rejects.toMatchObject({ code: 'unavailable' });
        boundary.rpc.mockResolvedValueOnce({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' });
        await expect(startAgentInstallJobRpc(target, request)).rejects.toMatchObject({ code: 'unavailable' });
        expect(boundary.rpc.mock.calls.map(([call]) => call.method)).toEqual(['daemon.agents.install.start', 'daemon.agents.install.start']);
    });
    it.each(['throw', 'result'] as const)('keeps temporary routing loss retryable (%s)', async carrier => {
        if (carrier === 'throw') boundary.rpc.mockRejectedValueOnce(new RpcError('Discovery failed', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));
        else boundary.rpc.mockResolvedValueOnce({ errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'Method not found' });
        await expect(startAgentInstallJobRpc({ machineId: 'machine', serverId: 'server' },
            { agentId: 'codex', intent: 'install', consent: { vendorRecipe: true } }))
            .rejects.toMatchObject({ code: 'request_failed' });
    });
});
