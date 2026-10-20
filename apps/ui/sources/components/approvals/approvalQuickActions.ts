import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readActionApprovalReview } from './actionApprovalReview';

export type ApprovalQuickActions = Readonly<{
    artifactId: string;
    serverId: string;
    actionId: 'approval.request.decide';
    decisions: readonly ['reject', 'approve'];
}>;

/** Full private input is required; an index header or a tolerant stored projection cannot authorize a shortcut. */
export function readApprovalQuickActions(artifact: DecryptedArtifact, serverId: string): ApprovalQuickActions | null {
    if (!artifact.isDecrypted || !serverId || typeof artifact.body !== 'string') return null;
    const matched = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
    if (matched?.family !== 'built_in') return null;
    let raw: unknown;
    try { raw = JSON.parse(artifact.body); } catch { return null; }
    const request = ApprovalRequestV2Schema.safeParse(raw);
    if (!request.success || !readActionApprovalReview(request.data).simple) return null;
    return { artifactId: artifact.id, serverId, actionId: 'approval.request.decide', decisions: ['reject', 'approve'] };
}
