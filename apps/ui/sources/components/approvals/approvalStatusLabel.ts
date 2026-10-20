import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { readApprovalExecutionFailure } from '@happier-dev/protocol/approvals/approvalExecutionFailure';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';

import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { t } from '@/text';

/** The request lifecycle uses the same words in its detail and retained tab. */
export function formatApprovalStatusLabel(status: string): string {
    switch (status) {
        case 'open': return t('approvals.status.open');
        case 'approved': return t('approvals.status.approved');
        case 'executing': return t('approvals.status.executing');
        case 'rejected': return t('approvals.status.rejected');
        case 'executed': return t('approvals.status.executed');
        case 'failed': return t('approvals.status.failed');
        case 'canceled': return t('approvals.status.canceled');
        default: return status;
    }
}

/**
 * The status a request reads as: an executed receipt whose Action refused its effect is Failed.
 * The detail page and the retained tab both read it, so they cannot disagree. Pass a failure the
 * caller already read to avoid reading it twice.
 */
export function resolveApprovalDisplayStatus(
    request: ApprovalRequest,
    failure: ReturnType<typeof readApprovalExecutionFailure> = readApprovalExecutionFailure(request),
): string {
    return failure ? 'failed' : request.status;
}

/** The tab's status: from the loaded request when this device holds its body, else the stored header's. */
export function readApprovalArtifactDisplayStatus(artifact: Pick<DecryptedArtifact, 'header' | 'body'>): string | null {
    const parsed = typeof artifact.body === 'string'
        ? approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body) : null;
    if (parsed?.family === 'built_in') return resolveApprovalDisplayStatus(parsed.request);
    return typeof artifact.header?.approvalStatus === 'string' ? artifact.header.approvalStatus : null;
}
