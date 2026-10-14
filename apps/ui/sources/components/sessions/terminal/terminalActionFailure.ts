import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * A terminal Action the approval gate deferred (a close that needs a decision, a cancellation still
 * settling) has not failed: nothing was stopped, and the next step is the person's.
 */
const AWAITING_APPROVAL_CODES: ReadonlySet<string> = new Set(['approval_request_created', 'terminal_approval_cancellation_pending']);

/** The one answer a terminal Action that did not complete gets, wherever the verb was started. */
export function presentTerminalActionFailure(result: Readonly<{ errorCode?: string; error?: string }>): void {
    const code = result.errorCode ?? result.error;
    Modal.alert(t(code && AWAITING_APPROVAL_CODES.has(code) ? 'approvals.waitingForYou' : 'terminalWorkspace.actionFailed'));
}
