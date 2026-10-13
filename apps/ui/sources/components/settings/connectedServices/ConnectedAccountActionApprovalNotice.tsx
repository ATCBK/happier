import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { t } from '@/text';
import type { ProviderPendingApproval } from '@/providers/actions/useProviderActionClient';

/** Presentation only: the mounted Action owner retains result and Account custody. */
export function ConnectedAccountActionApprovalNotice(props: Readonly<{
    execution?: Readonly<{
        approval: Pick<ReturnType<typeof useMountedActionExecution>['approval'], 'approvalId' | 'approvalPending'>;
        binding: Pick<NonNullable<ReturnType<typeof useMountedActionExecution>['binding']>, 'scope'> | null;
    }>;
    pendingApproval?: ProviderPendingApproval | null;
    testID?: string;
}>) {
    const router = useRouter();
    const { approvalId, approvalPending } = props.execution?.approval ?? {};
    const scope = props.execution?.binding?.scope;
    const href = props.pendingApproval?.href ?? (approvalId && approvalPending && scope
        ? `/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(scope.serverId)}` : null);
    if (!href) return null;
    return <ActionApprovalPendingNotice testID={props.testID} message={t('secrets.catalog.approvalPending')}
        onOpenApproval={() => router.pushRetainingCurrent(href)} />;
}
