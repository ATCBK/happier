import type { ApprovalSettledPresentation } from '@/sync/domains/artifacts/approvalArtifacts';
import { presentsSettledResourceProposal } from '@/components/approvals/resourceProposal/readResourceProposalApproval';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';

/**
 * Approval bodies that keep rendering in the transcript after a decision (plan 60 AGW-8: a resource
 * proposal's receipt or declined line). Each entry is contributed by its body owner; module-stable so
 * the transcript projection keeps its selector identity.
 */
export const TRANSCRIPT_SETTLED_APPROVAL_PRESENTATIONS: readonly ApprovalSettledPresentation[] = [
    // A settled request whose physical effect failed remains visible beside the Agent turn.
    (approval) => readApprovalExecutionFailure(approval) !== null,
    presentsSettledResourceProposal,
];
