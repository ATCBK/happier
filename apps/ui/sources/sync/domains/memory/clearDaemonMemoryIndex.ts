import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

/** Clears one machine's derived memory index (including indexed native conversations); its settings stay. */
export async function clearDaemonMemoryIndex(args: Readonly<{
    serverId: string;
    machineId: string;
    accountId: string;
    signal?: AbortSignal;
}>): Promise<void> {
    const result = await machineRpcWithServerScope<unknown, unknown>({
        machineId: args.machineId,
        serverId: args.serverId,
        accountId: args.accountId,
        preferScoped: true,
        ...(args.signal ? { signal: args.signal } : {}),
        method: RPC_METHODS.DAEMON_MEMORY_CLEAR_INDEX,
        payload: {},
    });
    if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) {
        throw new Error('memory_clear_index_failed');
    }
}
