import type { FilesystemTransferActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import { invokeWorkspaceFileSystemAction } from '@/sync/ops/workspaceFileSystem/actionInvocation';
import { callAdmittedFilesystemActionRpc } from '@/sync/ops/actions/filesystemActionDeps';

type FilesystemTransferActionParams = Omit<Parameters<typeof callAdmittedFilesystemActionRpc>[0], 'actionId'> & Readonly<{
    actionId: FilesystemTransferActionId | 'daemon.filesystem.copy';
}>;

/** Transport leaf of an already admitted read/copy/transfer; native root/requester policy still runs. */
export const callAdmittedFilesystemTransferActionRpc = callAdmittedFilesystemActionRpc;

/** The mounted transfer borrows UI Action admission before its daemon transport prepares bytes. */
export async function callFilesystemTransferAction(params: FilesystemTransferActionParams): Promise<unknown> {
    const result = await invokeWorkspaceFileSystemAction({ machineId: params.machineId,
        serverId: params.serverId ?? undefined, rootPath: '' }, params.actionId, params.input, {
        signal: params.signal, accountId: params.accountId,
        delivery: async ({ input, context }) => await callAdmittedFilesystemTransferActionRpc({ ...params, input, context,
            serverId: context.serverId ?? undefined, accountId: context.runtimeAccountId ?? undefined, requestId: context.actionRequestId ?? undefined, signal: context.signal }),
    });
    return result.ok ? result.result : result;
}
