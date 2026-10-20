import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import type { ActionOperationCredentialUseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';

import type { DiscussionRequesterApproval } from '@/sync/domains/artifacts/approvalArtifacts';

/**
 * What a shared Bot's requester-bound request says in its thread. The receipt replaces the request in
 * place: `done` only with effect evidence, `uncertain` when the effect may or may not have happened
 * (never drawn as success), `confirmed_pending` while an approved request has no result yet.
 */
export type ApprovalRequesterThreadState =
    | Readonly<{ kind: 'open' }>
    | Readonly<{ kind: 'confirmed_pending' | 'declined'; decidingAccountId: string | null }>
    | Readonly<{ kind: 'done' | 'uncertain'; decidingAccountId: string | null; operationCredentialUses?: readonly ActionOperationCredentialUseV1[] }>
    | Readonly<{ kind: 'failed'; decidingAccountId: string | null; errorCode: string | null; operationCredentialUses?: readonly ActionOperationCredentialUseV1[] }>
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
            // Only admitted receipt metadata describes actual use; Action result JSON and the
            // execution Account cannot establish the selected credential or its currentness.
            const currentExecution = parsed.family === 'target_action' ? parsed.request.execution
                : parsed.request.v === 2 ? parsed.request.execution : undefined;
            const uses = currentExecution?.effectAttempted !== false ? currentExecution?.operationCredentialUses : undefined;
            const credentialUse = uses?.length ? { operationCredentialUses: uses } : {};
            if (execution.errorCode === OUTCOME_UNKNOWN) return { kind: 'uncertain', decidingAccountId, ...credentialUse };
            const failure = !execution.ok ? { errorCode: execution.errorCode ?? null }
                : parsed.family === 'built_in' ? (() => {
                    const domainFailure = readApprovalExecutionFailure(parsed.request);
                    return domainFailure ? { errorCode: domainFailure.errorCode ?? null } : null;
                })() : null;
            if (failure?.errorCode === OUTCOME_UNKNOWN) return { kind: 'uncertain', decidingAccountId, ...credentialUse };
            return failure ? { kind: 'failed', decidingAccountId, errorCode: failure.errorCode, ...credentialUse }
                : { kind: 'done', decidingAccountId, ...credentialUse };
        }
        default:
            // Approved or executing: consent is given, the effect has not reported.
            return { kind: 'confirmed_pending', decidingAccountId };
    }
}
