import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { FilesystemMutationOutputSchema, type FilesystemActionId, type FilesystemMutationActionId } from '@happier-dev/protocol/actions/filesystemActionFamily';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import type { WorkspaceFileSystemTarget } from './directoryBrowsing';
import type { UiFilesystemActionDelivery } from '@/sync/ops/actions/filesystemActionDeps';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

export type WorkspaceFileSystemMutationResponse =
    | Readonly<{ success: true }>
    | Readonly<{ success: false; error: string; errorCode?: string; approvalArtifactId?: string }>;

/** One UI ingress for every filesystem Action; the caller retains result-domain parsing. */
export async function invokeWorkspaceFileSystemAction(
    target: WorkspaceFileSystemTarget,
    actionId: FilesystemActionId,
    input: unknown,
    options?: Readonly<{ signal?: AbortSignal | null; accountId?: string; delivery?: UiFilesystemActionDelivery['execute'] }>,
): Promise<ActionExecuteResult> {
    const lifetime = captureActiveServerAccountScopeLifetime();
    const serverId = target.serverId || lifetime?.scope.serverId;
    if (!serverId) return { ok: false, errorCode: 'action_home_not_found', error: 'action_home_not_found' };
    const activeTarget = lifetime && areServerProfileIdentifiersEquivalent(serverId, lifetime.scope.serverId);
    const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
    if (activeTarget && !lifetime.isCurrent()) return {
        ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed',
    };
    const retirement = options?.delivery ? new AbortController() : null;
    const subscription = retirement && activeTarget ? lifetime.onRetire(() => retirement.abort()) : null;
    const cancellation = retirement ? mergeAbortSignals([options?.signal ?? undefined, retirement.signal]) : null;
    const signal = cancellation?.signal ?? options?.signal ?? undefined;
    const execute = createFrontDoorActionExecute(createDefaultActionExecutor(options?.delivery && signal ? {
        filesystemActionDelivery: { actionId, signal, execute: options.delivery },
    } : undefined));
    const context = {
        surface: 'ui', authority: 'present_user', serverId,
        ...(options?.accountId ? { expectedAccountId: options.accountId }
            : activeTarget ? { expectedAccountId: lifetime.scope.accountId } : {}),
        ...(signal ? { signal } : {}),
        externalActionTarget: { kind: 'machine', machineId: target.machineId },
    } as const;
    try {
        // Run-now present-user entry: `execute` alone offers the in-place default confirmation.
        const result = await execute(actionId, input, context);
        // Cancellation stays a rejection for mounted byte-delivery callers; `execute` would
        // otherwise settle an aborted approval wait as a typed failure.
        if (!result.ok) signal?.throwIfAborted();
        return result;
    } finally {
        subscription?.dispose();
        cancellation?.dispose();
    }
}

/** Admission owns policy and approval; its existing terminal owns the Machine RPC. */
export async function invokeWorkspaceFileSystemMutation(
    target: WorkspaceFileSystemTarget,
    actionId: Exclude<FilesystemMutationActionId, 'daemon.filesystem.copy'>,
    input: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
): Promise<WorkspaceFileSystemMutationResponse> {
    const result = await invokeWorkspaceFileSystemAction(target, actionId, input, options);
    if (!result.ok) return { success: false, error: result.error, errorCode: result.errorCode };
    const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
    if (approval.success) return { success: false, errorCode: 'approval_required',
        error: 'The Action awaits approval.', approvalArtifactId: approval.data.artifactId };
    const parsed = FilesystemMutationOutputSchema.safeParse(result.result);
    return parsed.success ? parsed.data : { success: false, errorCode: 'invalid_action_output',
        error: 'The filesystem Action response could not be validated.' };
}
