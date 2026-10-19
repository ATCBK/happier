import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';

import type { DiscussionRequesterApproval } from '@/sync/domains/artifacts/approvalArtifacts';

/**
 * What a shared Bot's requester-bound request says in its thread. The receipt replaces the request in
 * place: `done` only with effect evidence, `uncertain` when the effect may or may not have happened
 * (never drawn as success), `confirmed_pending` while an approved request has no result yet.
 */
export type ApprovalRequesterThreadState =
    | Readonly<{ kind: 'open' }>
    | Readonly<{ kind: 'confirmed_pending' | 'done' | 'uncertain' | 'declined'; decidingAccountId: string | null }>
    | Readonly<{ kind: 'failed'; decidingAccountId: string | null; errorCode: string | null }>
    | Readonly<{ kind: 'canceled' }>;

const OUTCOME_UNKNOWN = 'approval_execution_outcome_unknown';

export function resolveApprovalRequesterThreadState(
    parsed: DiscussionRequesterApproval['parsed'],
    /** The answer this device's decision owner accepted, until the stored request catches up. */
    recordedDecision: 'approve' | 'reject' | null,
): ApprovalRequesterThreadState {
    const request = parsed.request;
    const deciding: unknown = request.decision?.decidingAccountId;
    const decidingAccountId = typeof deciding === 'string' ? deciding : null;
    switch (request.status) {
        case 'open':
            return recordedDecision === 'reject' ? { kind: 'declined', decidingAccountId: null }
                : recordedDecision === 'approve' ? { kind: 'confirmed_pending', decidingAccountId: null } : { kind: 'open' };
        case 'rejected':
            return { kind: 'declined', decidingAccountId };
        case 'canceled':
            return { kind: 'canceled' };
        case 'executed':
        case 'failed': {
            const execution = request.execution;
            if (!execution) return { kind: 'confirmed_pending', decidingAccountId };
            if (execution.errorCode === OUTCOME_UNKNOWN) return { kind: 'uncertain', decidingAccountId };
            const failure = !execution.ok ? { errorCode: execution.errorCode ?? null }
                : parsed.family === 'built_in' ? (() => {
                    const domainFailure = readApprovalExecutionFailure(parsed.request);
                    return domainFailure ? { errorCode: domainFailure.errorCode ?? null } : null;
                })() : null;
            if (failure?.errorCode === OUTCOME_UNKNOWN) return { kind: 'uncertain', decidingAccountId };
            return failure ? { kind: 'failed', decidingAccountId, errorCode: failure.errorCode } : { kind: 'done', decidingAccountId };
        }
        default:
            // Approved or executing: consent is given, the effect has not reported.
            return { kind: 'confirmed_pending', decidingAccountId };
    }
}
