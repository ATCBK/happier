import { DaemonWorkspaceFileReplacePreviewRequestSchema, DaemonWorkspaceFileReplacePreviewResponseSchema,
    DaemonWorkspaceFileReplaceApplyRequestSchema, DaemonWorkspaceFileReplaceApplyResponseSchema,
    type DaemonWorkspaceFileReplacePreviewRequest, type DaemonWorkspaceFileReplacePreviewResponse,
    type DaemonWorkspaceFileReplaceApplyRequest, type DaemonWorkspaceFileReplaceApplyResponse } from '@happier-dev/protocol/machines/workspaceFiles';
import { classifyWorkspaceFileRpcError, type WorkspaceFileRpcErrorCode } from './machineWorkspaceFileRpcError';
import { captureLazyActionAccountContext, withActionAccountRequestSignal } from '@/sync/ops/actions/actionAccountContext';
import { resumeActionExecutionResult, type ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { settleUiWorkspaceFileReplaceResult } from './actions/workspaceFileReplaceAction';
import { randomUUID } from '@/platform/randomUUID';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';

type Options = Readonly<{ serverId?: string | null; accountId?: string | null; signal?: AbortSignal;
    /** Releases only mounted result custody, not a durable approval or Machine write. */
    continuationSignal?: AbortSignal;
    onApprovalPending?: (registration: ActionApprovalContinuation) => void;
}>;
type TransportFailure = Readonly<{ ok: false; errorCode: WorkspaceFileRpcErrorCode }>;

export async function machineWorkspaceFileReplacePreview(machineId: string, input: DaemonWorkspaceFileReplacePreviewRequest, options?: Options): Promise<DaemonWorkspaceFileReplacePreviewResponse | TransportFailure | ActionExecuteFailure> {
    const payload = DaemonWorkspaceFileReplacePreviewRequestSchema.parse(input);
    try {
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const signal = options?.signal;
        const scope = options?.serverId && options.accountId ? { serverId: options.serverId, accountId: options.accountId } : null;
        const execution = await createDefaultActionExecutor(signal && scope && options?.onApprovalPending ? {
            hostActionApprovalLifetime: { actionId: 'workspace.files.replace.preview', signal, surface: 'ui' },
            onBlockingApprovalPending: ({ artifactId }) => {
                if (signal.aborted || !scope) return;
                // Presentation observes the same retained invocation; the Action
                // lifetime owns its decision, result and withdrawal.
                options?.onApprovalPending?.({ artifactId, scope, signal, refreshAfterExecution: false,
                    onExecuted: async () => 'ignored' });
            },
        } : undefined).execute('workspace.files.replace.preview', { machineId, ...payload }, {
            surface: 'ui', authority: 'present_user', externalActionTarget: { kind: 'machine', machineId },
            ...(options?.serverId ? { serverId: options.serverId } : {}),
            ...(options?.accountId ? { expectedAccountId: options.accountId } : {}),
            ...(signal ? { signal } : {}),
        });
        if (!execution.ok) return execution;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        let result: unknown = execution.result;
        if (approval.success) {
            if (!options?.onApprovalPending || !options.serverId || !options.accountId)
                return { ok: false, errorCode: 'approval_required', error: 'approval_required', details: approval.data };
            // A read the person asked to approve answers once approved, through the same continuation as writes.
            const resumed = await resumeActionExecutionResult({ result: execution, actionId: 'workspace.files.replace.preview',
                actionInput: { machineId, ...payload }, scope: { serverId: options.serverId, accountId: options.accountId },
                signal: options.continuationSignal, onApprovalPending: options.onApprovalPending });
            if (!resumed.ok) return resumed;
            result = resumed.result;
        }
        const parsed = DaemonWorkspaceFileReplacePreviewResponseSchema.safeParse(result);
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
        const requestId = randomUUID();
        const actionInput = { machineId, ...payload };
        const execution = await executeDefaultActionInCapturedAccount(account, 'workspace.files.replace', actionInput, {
            surface: 'ui', authority: 'present_user', expectedAccountId: options?.accountId ?? account.accountId,
            actionRequestId: requestId,
            externalActionTarget: { kind: 'machine', machineId }, signal: options?.signal,
        });
        if (!execution.ok) return execution;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(execution.result);
        if (approval.success) {
            if (!options?.onApprovalPending) return { ok: false, errorCode: 'approval_required', error: 'approval_required', details: approval.data };
            return await withActionAccountRequestSignal({ accountLifetime: account.accountOnlyLifetime }, options.continuationSignal, async signal => {
                const resumed = await resumeActionExecutionResult({ result: execution, actionId: 'workspace.files.replace', actionInput,
                    scope: { serverId: account.serverId, accountId: account.accountId }, requestId, signal,
                    onApprovalPending: options.onApprovalPending!,
                });
                return resumed.ok ? await settleUiWorkspaceFileReplaceResult(account, actionInput, resumed.result, requestId, signal, options.signal) : resumed;
            });
        }
        const parsed = DaemonWorkspaceFileReplaceApplyResponseSchema.safeParse(execution.result);
        return parsed.success ? parsed.data : { ok: false, errorCode: 'transport_failed' };
    } catch (error) {
        if (options?.signal?.aborted) throw error;
        return { ok: false, errorCode: classifyWorkspaceFileRpcError(error) };
    } finally { account.dispose(); }
}
