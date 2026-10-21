import { DaemonWorkspaceFileReplacePreviewRequestSchema, DaemonWorkspaceFileReplacePreviewResponseSchema,
    DaemonWorkspaceFileReplaceApplyRequestSchema, DaemonWorkspaceFileReplaceApplyResponseSchema,
    type DaemonWorkspaceFileReplacePreviewRequest, type DaemonWorkspaceFileReplacePreviewResponse,
    type DaemonWorkspaceFileReplaceApplyRequest, type DaemonWorkspaceFileReplaceApplyResponse } from '@happier-dev/protocol/machines/workspaceFiles';
import { classifyWorkspaceFileRpcError, type WorkspaceFileRpcErrorCode } from './machineWorkspaceFileRpcError';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

type Options = Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal }>;
type TransportFailure = Readonly<{ ok: false; errorCode: WorkspaceFileRpcErrorCode }>;

export async function machineWorkspaceFileReplacePreview(machineId: string, input: DaemonWorkspaceFileReplacePreviewRequest, options?: Options): Promise<DaemonWorkspaceFileReplacePreviewResponse | TransportFailure | ActionExecuteFailure> {
    const payload = DaemonWorkspaceFileReplacePreviewRequestSchema.parse(input);
    try {
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const execution = await createDefaultActionExecutor().execute('workspace.files.replace.preview', { machineId, ...payload }, {
            surface: 'ui', authority: 'present_user', externalActionTarget: { kind: 'machine', machineId },
            ...(options?.serverId ? { serverId: options.serverId } : {}),
            ...(options?.accountId ? { expectedAccountId: options.accountId } : {}),
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (!execution.ok) return execution;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        if (approval.success) return { ok: false, errorCode: 'approval_required', error: 'approval_required', details: approval.data };
        const parsed = DaemonWorkspaceFileReplacePreviewResponseSchema.safeParse(execution.result);
        return parsed.success ? parsed.data : { ok: false, errorCode: 'transport_failed' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { ok: false, errorCode: classifyWorkspaceFileRpcError(error) };
    }
}

export async function machineWorkspaceFileReplaceApply(machineId: string, input: DaemonWorkspaceFileReplaceApplyRequest, options?: Options): Promise<DaemonWorkspaceFileReplaceApplyResponse | TransportFailure | ActionExecuteFailure> {
    const payload = DaemonWorkspaceFileReplaceApplyRequestSchema.parse(input);
    const active = captureActiveServerAccountScopeLifetime();
    const serverId = options?.serverId ?? active?.scope.serverId;
    if (!serverId) return { ok: false, errorCode: 'action_home_not_found', error: 'action_home_not_found' };
    // The user signal belongs to cooperative Machine cancellation. Account
    // retirement alone owns the captured carrier and terminal-receipt lifetime.
    const account = await captureLazyActionAccountContext(serverId);
    try {
        const { executeDefaultActionInCapturedAccount } = await import('./actions/defaultActionExecutor');
        const execution = await executeDefaultActionInCapturedAccount(account, 'workspace.files.replace', { machineId, ...payload }, {
            surface: 'ui', authority: 'present_user', expectedAccountId: options?.accountId ?? account.accountId,
            externalActionTarget: { kind: 'machine', machineId }, signal: options?.signal,
        });
        if (!execution.ok) return execution;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        if (approval.success) return { ok: false, errorCode: 'approval_required', error: 'approval_required', details: approval.data };
        const parsed = DaemonWorkspaceFileReplaceApplyResponseSchema.safeParse(execution.result);
        return parsed.success ? parsed.data : { ok: false, errorCode: 'transport_failed' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { ok: false, errorCode: classifyWorkspaceFileRpcError(error) };
    } finally { account.dispose(); }
}
