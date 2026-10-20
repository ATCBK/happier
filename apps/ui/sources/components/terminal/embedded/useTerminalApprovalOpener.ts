import * as React from 'react';

import { buildApprovalHref } from '@/components/approvals/approvalNavigation';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { EmbeddedTerminalPaneController } from './types';

/**
 * The "Approvals" shortcut of a terminal that waits for consent: opens the pending request in the Inbox.
 * One opener for every terminal host (Workspace pane, Machine sheet); absent until the request exists.
 */
export function useTerminalApprovalOpener(
    controller: Pick<EmbeddedTerminalPaneController, 'approvalId' | 'approvalServerId'>,
): (() => void) | undefined {
    const router = useRouter();
    const { approvalId, approvalServerId } = controller;
    return React.useMemo(() => approvalId && approvalServerId
        ? () => router.pushRetainingCurrent(buildApprovalHref(approvalId, approvalServerId))
        : undefined, [approvalId, approvalServerId, router]);
}
