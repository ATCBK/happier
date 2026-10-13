import {
    DaemonWorkspaceFileSearchRequestSchema,
    DaemonWorkspaceFileSearchResponseSchema,
    type DaemonWorkspaceFileSearchRequest,
    type DaemonWorkspaceFileSearchResponse,
} from '@happier-dev/protocol/machines/workspaceFiles';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { classifyWorkspaceFileRpcError, type WorkspaceFileRpcErrorCode } from './machineWorkspaceFileRpcError';

export async function machineWorkspaceFileSearch(
    machineId: string,
    input: DaemonWorkspaceFileSearchRequest,
    options?: Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal }>,
): Promise<DaemonWorkspaceFileSearchResponse | Readonly<{ ok: false; errorCode: WorkspaceFileRpcErrorCode }>> {
    const payload = DaemonWorkspaceFileSearchRequestSchema.parse(input);
    try {
        const response = await machineRpcWithServerScope<unknown, DaemonWorkspaceFileSearchRequest>({
            machineId,
            method: RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH,
            payload,
            serverId: options?.serverId ?? null,
            accountId: options?.accountId ?? null,
            operationTimeoutMs: null,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        const parsed = DaemonWorkspaceFileSearchResponseSchema.safeParse(response);
        return parsed.success ? parsed.data : { ok: false, errorCode: 'transport_failed' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { ok: false, errorCode: classifyWorkspaceFileRpcError(error) };
    }
}
