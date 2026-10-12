import { describe, expect, it, vi } from 'vitest';
import { machineGetBugReportLogTail, machineReadSessionLogTail } from './machines';

const machineRPC = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(machineRPC);
});

describe('machineReadSessionLogTail', () => {
    it('reads an explicit log path through the machine diagnostics method', async () => {
        const response = { success: true, path: '/happier/logs/session.log', tail: 'last line', truncated: true };
        machineRPC.mockResolvedValueOnce(response);

        await expect(machineReadSessionLogTail('machine-1', {
            path: response.path, maxBytes: 32_000,
        }, { timeoutMs: 5_000 })).resolves.toEqual(response);
        expect(machineRPC).toHaveBeenCalledWith({
            machineId: 'machine-1',
            method: 'daemon.session.log.tail',
            payload: { path: response.path, maxBytes: 32_000 },
            timeoutMs: 5_000,
        });
    });

    it('preserves a transport failure as a failed diagnostic read', async () => {
        machineRPC.mockRejectedValueOnce(new Error('Machine offline'));
        await expect(machineReadSessionLogTail('machine-1', { path: '/happier/logs/session.log' }))
            .resolves.toEqual({ success: false, error: 'Machine offline' });
    });

    it('routes bug-report log reads through the same machine RPC owner', async () => {
        const response = { ok: true, path: '/happier/logs/daemon.log', tail: 'last line' };
        machineRPC.mockResolvedValueOnce(response);

        await expect(machineGetBugReportLogTail('machine-1', {
            path: response.path, maxBytes: 16_000,
        }, { timeoutMs: 4_000 })).resolves.toEqual(response);
        expect(machineRPC).toHaveBeenCalledWith({
            machineId: 'machine-1',
            method: 'bugreport.getLogTail',
            payload: { path: response.path, maxBytes: 16_000 },
            timeoutMs: 4_000,
        });
    });
});
