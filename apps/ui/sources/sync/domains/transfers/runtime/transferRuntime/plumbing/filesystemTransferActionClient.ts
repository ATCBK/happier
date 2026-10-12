import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { FilesystemTransferActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { callGuardedMachineRpcWithPolicy } from '@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc';
import { invokeWorkspaceFileSystemAction } from '@/sync/ops/workspaceFileSystem/actionInvocation';

type FilesystemTransferActionParams = Readonly<{
    actionId: FilesystemTransferActionId | 'daemon.filesystem.copy';
    machineId: string;
    serverId?: string | null;
    accountId?: string;
    input: unknown;
    timeoutMs?: number | null;
    signal?: AbortSignal | null;
    requestId?: string;
}>;

/** Transport leaf of an already admitted read/copy/transfer; native root/requester policy still runs. */
export async function callAdmittedFilesystemTransferActionRpc(params: FilesystemTransferActionParams): Promise<unknown> {
    const method = getActionSpec(params.actionId).bindings?.rpcMethod;
    if (!method) throw new Error('Filesystem transfer Action RPC binding is unavailable');
    return await callGuardedMachineRpcWithPolicy({ machineId: params.machineId,
        ...(typeof params.serverId === 'string' ? { serverId: params.serverId } : {}),
        accountId: params.accountId, requestId: params.requestId,
        method, payload: { kind: 'targeted_action_rpc', target: { kind: 'machine', machineId: params.machineId }, input: params.input },
        ...(typeof params.timeoutMs === 'number' ? { timeoutMs: params.timeoutMs } : {}),
        ...(params.actionId !== 'daemon.filesystem.transfer.cancel' ? { operationTimeoutMs: null } : {}),
        ...(params.signal ? { signal: params.signal } : {}),
    });
}

/** The mounted transfer borrows UI Action admission before its daemon transport prepares bytes. */
export async function callFilesystemTransferAction(params: FilesystemTransferActionParams): Promise<unknown> {
    const result = await invokeWorkspaceFileSystemAction({ machineId: params.machineId,
        serverId: params.serverId, rootPath: '' }, params.actionId, params.input, {
        signal: params.signal, accountId: params.accountId,
        delivery: async ({ input, context }) => await callAdmittedFilesystemTransferActionRpc({ ...params, input,
            serverId: context.serverId, accountId: context.runtimeAccountId, requestId: context.actionRequestId, signal: context.signal }),
    });
    return result.ok ? result.result : result;
}
