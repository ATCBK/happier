import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PendingResetStartWaitingReasonV1Schema } from '@happier-dev/protocol/sessions/pending/pendingResetStartReadinessV1';
import { t } from '@/text';

/** Present the canonical admission refusal without re-deciding allowance readiness. */
export function usageResetStartFailureMessage(failure: ActionExecuteFailure): string {
    if (failure.errorCode !== 'reset_start_unavailable') return t('usage.board.plans.resetStartFailed');
    const details = failure.details;
    const reason = PendingResetStartWaitingReasonV1Schema.safeParse(
        details && typeof details === 'object' && 'reason' in details ? details.reason : undefined,
    );
    if (!reason.success) return t('usage.board.plans.resetStartFailed');
    switch (reason.data) {
        case 'authority_unavailable': return t('usage.board.plans.resetStartAuthority');
        case 'witness_unavailable': return t('usage.board.plans.resetStartNoWitness');
        case 'unknown_window': return t('usage.board.plans.resetStartNoReset');
        case 'quota_unavailable': return t('usage.board.plans.resetStartNoReading');
        case 'quota_stale':
        case 'reset_not_observed': return t('usage.board.plans.resetStartStale');
        case 'window_changed':
        case 'window_expired':
        case 'entitlement_changed':
        case 'denominator_changed': return t('usage.board.plans.resetStartChanged');
        case 'before_reset': return t('usage.board.plans.resetStartFailed');
    }
}
