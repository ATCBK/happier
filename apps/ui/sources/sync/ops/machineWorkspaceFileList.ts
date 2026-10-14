import {
    DaemonWorkspaceFileListRequestSchema,
    DaemonWorkspaceFileListResponseSchema,
    type DaemonWorkspaceFileListRequest,
    type DaemonWorkspaceFileListResponse,
    type DaemonWorkspaceFileListErrorCode,
} from '@happier-dev/protocol/machines/workspaceFiles';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { classifyWorkspaceFileRpcError, type WorkspaceFileRpcErrorCode } from './machineWorkspaceFileRpcError';

// Client failures are not daemon wire responses and must not expand its schema.
export type MachineWorkspaceFileListErrorCode = DaemonWorkspaceFileListErrorCode | WorkspaceFileRpcErrorCode | 'invalid_response';
export type MachineWorkspaceFileListResponse = DaemonWorkspaceFileListResponse
    | Readonly<{ ok: false; errorCode: WorkspaceFileRpcErrorCode | 'invalid_response' }>;

export async function machineWorkspaceFileList(
    machineId: string,
    input: DaemonWorkspaceFileListRequest,
    options?: Readonly<{
        serverId?: string | null;
        accountId?: string | null;
        timeoutMs?: number;
        signal?: AbortSignal;
    }>,
): Promise<MachineWorkspaceFileListResponse> {
    const payload = DaemonWorkspaceFileListRequestSchema.parse(input);
    try {
        const response = await machineRpcWithServerScope<unknown, DaemonWorkspaceFileListRequest>({
            machineId,
            method: RPC_METHODS.DAEMON_WORKSPACE_FILES_LIST,
            payload,
            preparePayload: (budgetMs) => ({ ...payload, budgetMs }),
            serverId: options?.serverId ?? null,
            accountId: options?.accountId ?? null,
            timeoutMs: options?.timeoutMs,
            // The scan spends the remaining caller budget and returns partial
            // results. A competing ACK timer would discard that terminal page.
            operationTimeoutMs: null,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        const parsed = DaemonWorkspaceFileListResponseSchema.safeParse(response);
        return parsed.success ? parsed.data : { ok: false, errorCode: 'invalid_response' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { ok: false, errorCode: classifyWorkspaceFileRpcError(error) };
    }
}
