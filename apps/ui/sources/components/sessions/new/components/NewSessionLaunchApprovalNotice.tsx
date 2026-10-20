import * as React from 'react';

import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { t } from '@/text';

/** A launch that waits on an approval: what waits, in the approval's own words, and one way to review it. */
export type NewSessionLaunchApprovalNoticeState = Readonly<{
    summary: string | null;
    onOpen: () => void;
}>;

/** Sits where a launch failure would, above the composer that still holds the draft. */
export function NewSessionLaunchApprovalNotice(props: Readonly<{
    approval: NewSessionLaunchApprovalNoticeState | null | undefined;
}>): React.ReactElement | null {
    if (!props.approval) return null;
    return (
        <ActionApprovalPendingNotice
            testID="new-session-launch-approval"
            presentation="banner"
            message={props.approval.summary ?? t('newSession.launchApprovalTitle')}
            description={t('newSession.launchApprovalBody')}
            onOpenApproval={props.approval.onOpen}
        />
    );
}
