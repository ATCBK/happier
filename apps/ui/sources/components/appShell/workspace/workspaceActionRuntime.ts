import type { WorkspaceActionId } from '@happier-dev/protocol';
import { workspaceActionFailure, type WorkspaceActionOutcome } from './workspaceActions';
import { ActionApprovalRequestCreatedResultSchema, type ActionExecuteResult, isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import { captureActiveServerAccountScopeCurrentness, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import type { Href } from 'expo-router';
import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { presentActionTurnedOffNoticeIfOff } from '@/sync/ops/actions/actionTurnedOffNotice';
import { Modal } from '@/modal';
import { t } from '@/text';

type MountedWorkspaceAction = (request: Readonly<{ actionId: WorkspaceActionId; input: unknown; signal?: AbortSignal }>) => Promise<WorkspaceActionOutcome>;
let mounted: MountedWorkspaceAction | null = null;

/** One client/window has one WorkspaceProvider. Cleanup cannot retire a newer mount. */
export function registerMountedWorkspaceAction(execute: MountedWorkspaceAction): () => void {
    mounted = execute;
    return () => { if (mounted === execute) mounted = null; };
}

export function captureMountedWorkspaceAction(): MountedWorkspaceAction | null {
    return mounted;
}

/** A mounted workspace owns navigation; only an absent mount uses the native router. */
export async function openWorkspaceHrefOrElse(href: string, fallback: () => void): Promise<void> {
    const execute = captureMountedWorkspaceAction();
    if (!execute) { fallback(); return; }
    const result = await execute({ actionId: 'workspace.tabs.open', input: { href } });
    if (!result.ok) throw new Error(result.errorCode);
}

export async function invokeWorkspaceAction(request: Parameters<MountedWorkspaceAction>[0]): Promise<WorkspaceActionOutcome> {
    return mounted ? await mounted(request) : workspaceActionFailure('unsupported_action');
}

/** Human menus and shortcuts enter Action policy before reaching the admitted mounted transport. */
export async function executeWorkspaceUiAction(request: Parameters<MountedWorkspaceAction>[0], openApproval: (href: Href) => void): Promise<ActionExecuteResult> {
    const lifetime = captureActiveServerAccountScopeCurrentness();
    const scope = getActiveServerAccountScope();
    try {
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        const result = await createFrontDoorActionExecute()(request.actionId, request.input, {
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
            ...(scope ? { serverId: scope.serverId, expectedAccountId: scope.accountId } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
        });
        if (result.ok) {
            const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
            if (pending.success && scope && lifetime.isCurrent()) openApproval(buildApprovalHref(pending.data.artifactId, scope.serverId));
        } else if (lifetime.isCurrent() && !isActionApprovalDeclinedErrorCode(result.errorCode) && !['workspace_navigation_cancelled', 'action_cancelled'].includes(result.errorCode)) {
            if (!presentActionTurnedOffNoticeIfOff(result, request.actionId)) await Modal.alertAsync(t('common.error'), t('common.unavailable'));
        }
        return result;
    } catch {
        if (lifetime.isCurrent()) await Modal.alertAsync(t('common.error'), t('common.unavailable'));
        return { ok: false as const, errorCode: 'workspace_action_failed', error: 'workspace_action_failed' };
    }
}
