import { DaemonWorkspaceFileReplacePreviewRequestSchema, DaemonWorkspaceFileReplacePreviewResponseSchema,
    DaemonWorkspaceFileReplaceApplyRequestSchema, DaemonWorkspaceFileReplaceApplyResponseSchema,
    type DaemonWorkspaceFileReplacePreviewRequest, type DaemonWorkspaceFileReplacePreviewResponse,
    type DaemonWorkspaceFileReplaceApplyRequest, type DaemonWorkspaceFileReplaceApplyResponse } from '@happier-dev/protocol/machines/workspaceFiles';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { classifyWorkspaceFileRpcError, type WorkspaceFileRpcErrorCode } from './machineWorkspaceFileRpcError';

type Options = Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal }>;
type TransportFailure = Readonly<{ ok: false; errorCode: WorkspaceFileRpcErrorCode }>;

export async function machineWorkspaceFileReplacePreview(machineId: string, input: DaemonWorkspaceFileReplacePreviewRequest, options?: Options): Promise<DaemonWorkspaceFileReplacePreviewResponse | TransportFailure> {
    const payload = DaemonWorkspaceFileReplacePreviewRequestSchema.parse(input);
    try {
        const response = await machineRpcWithServerScope<unknown, DaemonWorkspaceFileReplacePreviewRequest>({
            machineId, method: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_PREVIEW, payload,
            serverId: options?.serverId ?? null, accountId: options?.accountId ?? null, operationTimeoutMs: null,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        const parsed = DaemonWorkspaceFileReplacePreviewResponseSchema.safeParse(response);
        return parsed.success ? parsed.data : { ok: false, errorCode: 'transport_failed' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { ok: false, errorCode: classifyWorkspaceFileRpcError(error) };
    }
}

export async function machineWorkspaceFileReplaceApply(machineId: string, input: DaemonWorkspaceFileReplaceApplyRequest, options?: Options): Promise<DaemonWorkspaceFileReplaceApplyResponse | TransportFailure> {
    const payload = DaemonWorkspaceFileReplaceApplyRequestSchema.parse(input);
    try {
        const response = await machineRpcWithServerScope<unknown, DaemonWorkspaceFileReplaceApplyRequest>({
            machineId, method: RPC_METHODS.DAEMON_WORKSPACE_FILES_REPLACE_APPLY, payload,
            serverId: options?.serverId ?? null, accountId: options?.accountId ?? null, operationTimeoutMs: null,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        const parsed = DaemonWorkspaceFileReplaceApplyResponseSchema.safeParse(response);
        return parsed.success ? parsed.data : { ok: false, errorCode: 'transport_failed' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { ok: false, errorCode: classifyWorkspaceFileRpcError(error) };
    }
}
