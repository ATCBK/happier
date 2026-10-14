import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const machineRpcWithServerScopeMock = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpcWithServerScopeMock,
}));

describe('machine MCP servers ops (server-scoped routing)', () => {
    beforeEach(() => {
        machineRpcWithServerScopeMock.mockReset();
    });

    it('routes daemon mcpServers.detect through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, servers: [], warnings: [] });
        const { machineMcpServersDetect } = await import('./machineMcpServers');

        const res = await machineMcpServersDetect('machine-1', { directory: '/tmp', providers: ['claude'] }, { serverId: 'server-a' });

        expect(res).toEqual({ ok: true, servers: [], warnings: [] });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_MCP_SERVERS_DETECT,
            payload: expect.objectContaining({ machineId: 'machine-1', directory: '/tmp', providers: ['claude'] }),
        }));
    });

    it('routes daemon mcpServers.test through server-scoped machine rpc', async () => {
        machineRpcWithServerScopeMock.mockResolvedValueOnce({ ok: true, toolCount: 1, durationMs: 10 });
        const { machineMcpServersTest } = await import('./machineMcpServers');

        const res = await machineMcpServersTest(
            'machine-1',
            {
                t: 'byId',
                directory: '/tmp',
                serverId: 'srv_1',
            },
            { serverId: 'server-a' },
        );

        expect(res).toEqual({ ok: true, toolCount: 1, durationMs: 10 });
        expect(machineRpcWithServerScopeMock).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine-1',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_MCP_SERVERS_TEST,
            payload: expect.objectContaining({ t: 'byId', machineId: 'machine-1', directory: '/tmp', serverId: 'srv_1' }),
        }));
    });
});
