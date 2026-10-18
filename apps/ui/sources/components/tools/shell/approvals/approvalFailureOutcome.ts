import type { ActionExecuteFailure, ApprovalRequest } from '@happier-dev/protocol';

import { t } from '@/text';
import { isApprovalDecisionStale, presentApprovalFailure } from './useApprovalDecisionHandler';

/** A stale request was never dispatched, so its headline must not name the action as attempted. */
function readFailureHeadline(actionId: string, failure: ActionExecuteFailure): string {
    if (isApprovalDecisionStale(failure)) return t('approvals.failureNotRun');
    switch (actionId) {
        case 'daemon.filesystem.writeFile': return t('approvals.failureFileWrite');
        case 'daemon.filesystem.readFile': return t('approvals.failureFileRead');
        default: return actionId.startsWith('daemon.filesystem.') ? t('approvals.failureFileOther') : t('approvals.failureGeneric');
    }
}

/**
 * What a settled approval whose effect failed says to a person: a plain headline for the outcome, a readable
 * reason when the failure has one, and the executor's own words and code for the Details disclosure.
 */
export function presentApprovalFailureOutcome(approval: ApprovalRequest, failure: ActionExecuteFailure): Readonly<{
    headline: string;
    /** Localized copy for a failure the product recognises (stale, provider); null for the executor's raw text. */
    reason: string | null;
    /** The executor's raw error, kept apart from the headline; null when it adds nothing beyond the code. */
    message: string | null;
    code: string | null;
}> {
    const presented = presentApprovalFailure(failure, failure.error);
    const readable = presented.code === null;
    return {
        headline: readFailureHeadline(approval.actionId, failure),
        reason: readable ? presented.reason : null,
        message: readable || failure.error === failure.errorCode ? null : failure.error,
        code: presented.code,
    };
}
