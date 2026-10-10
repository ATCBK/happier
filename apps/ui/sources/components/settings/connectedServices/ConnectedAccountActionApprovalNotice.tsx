import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import type { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { t } from '@/text';

/** Presentation only: the mounted Action owner retains result and Account custody. */
export function ConnectedAccountActionApprovalNotice(props: Readonly<{
    execution: Pick<ReturnType<typeof useMountedActionExecution>, 'approval' | 'binding'> | undefined;
    testID?: string;
}>) {
    const router = useRouter();
    const { approvalId, approvalPending } = props.execution?.approval ?? {};
    const scope = props.execution?.binding?.scope;
    if (!approvalId || !approvalPending || !scope) return null;
    return <ActionApprovalPendingNotice testID={props.testID} message={t('secrets.catalog.approvalPending')}
        onOpenApproval={() => router.push(`/inbox/approvals/${encodeURIComponent(approvalId)}?serverId=${encodeURIComponent(scope.serverId)}`)} />;
}
