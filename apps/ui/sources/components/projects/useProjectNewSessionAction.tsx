import * as React from 'react';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionAuthoringOpenResultV1Schema, type PluginUiNewSessionSeedV1 } from '@happier-dev/protocol/plugins/ui';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { useActionApprovalContinuation } from '@/components/approvals/useActionApprovalContinuation';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { Modal } from '@/modal';
import { t } from '@/text';

const authoringExecuted = () => {};

/** Both ordinary Project launchers use the admitted draft owner, never a private seed route. */
export function useProjectNewSessionAction(target: WorkspaceScopeBase) {
    const router = useRouter();
    const accountScope = useActiveServerAccountScope();
    const targetKey = JSON.stringify([target.serverId, target.machineId, target.rootPath]);
    const currentTargetKey = React.useRef(targetKey);
    currentTargetKey.current = targetKey;
    const mounted = React.useRef(true);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
    }, []);
    const approval = useActionApprovalContinuation({
        scopeKey: JSON.stringify([accountScope?.serverId, accountScope?.accountId, targetKey]),
        serverId: target.serverId, onExecuted: authoringExecuted,
    });
    const open = React.useCallback(async () => {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime || !areServerProfileIdentifiersEquivalent(target.serverId, lifetime.scope.serverId)) return;
        const current = () => mounted.current && lifetime.isCurrent() && currentTargetKey.current === targetKey;
        const unavailable = () => {
            if (current()) Modal.alert(t('projects.identity.newSessionUnavailable'));
        };
        const seed = { placement: { kind: 'exactTarget', serverId: target.serverId,
            machineId: target.machineId, directory: target.rootPath } } satisfies PluginUiNewSessionSeedV1;
        try {
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            if (!current()) return;
            const prepared = await createFrontDoorActionExecute(createDefaultActionExecutor()).prepare('session.authoring.open', { seed }, {
                surface: 'ui', authority: 'present_user', serverId: lifetime.scope.serverId,
                expectedAccountId: lifetime.scope.accountId,
            });
            if (!current()) return;
            const result = prepared.kind === 'settled' ? prepared.result : await prepared.invocation.run();
            if (!current()) return;
            if (!result.ok) { unavailable(); return; }
            const pending = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
            if (pending.success) { approval.requestApproval(pending.data.artifactId); return; }
            const outcome = SessionAuthoringOpenResultV1Schema.safeParse(result.result);
            if (!outcome.success || outcome.data.kind === 'unavailable') unavailable();
        } catch { unavailable(); }
    }, [approval.requestApproval, target.serverId, target.machineId, target.rootPath, targetKey]);
    const approvalId = approval.approvalId;
    const approvalNotice = approval.approvalPending && approvalId
        ? <ActionApprovalPendingNotice message={t('approvals.status.open')} testID="project-new-session-approval"
            onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(target.serverId)}`)} />
        : null;
    return { open, approvalNotice };
}
