import { APPROVAL_ARTIFACT_KINDS_V1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { ApprovalRequestStatusSchema, ApprovalRequestV2StatusSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1,
    AccountNoticeArtifactHeaderV1Schema, UsageNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

import { isOpenApprovalInboxArtifact, listOpenApprovalInboxArtifactHydrationRequests } from './approvalArtifacts';
import { readAccountNoticeArtifactHeader } from './usageNoticeArtifacts';
import type { DecryptedArtifact } from './artifactTypes';

const approvalKinds: readonly string[] = Object.values(APPROVAL_ARTIFACT_KINDS_V1);
const noticeKinds: readonly string[] = [ACCOUNT_NOTICE_ARTIFACT_KIND_V1, USAGE_NOTICE_ARTIFACT_KIND_V1];
export const INBOX_ARTIFACT_KINDS: readonly string[] = Object.freeze([...approvalKinds, ...noticeKinds].sort());

type InboxArtifactHydrationRequest = Readonly<{
    artifactId: string; serverId: string; headerVersion: number; bodyVersion?: number;
}>;

/** The existing exact-body owner admits the same families the Inbox's strict readers classify. */
export function listInboxArtifactBodyHydrationRequests(artifacts: readonly DecryptedArtifact[],
    serverId: string | null | undefined, accountId: string | null | undefined): readonly InboxArtifactHydrationRequest[] {
    const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]));
    const requests = new Map(listOpenApprovalInboxArtifactHydrationRequests(artifacts, serverId)
        .map(request => [request.artifactId, request]));
    if (serverId && accountId) for (const artifact of artifacts) {
        if (artifact.draft || !artifact.isDecrypted || artifact.body !== undefined
            || !noticeKinds.includes(artifact.header?.kind ?? '') || artifact.header?.status !== 'open'
            || artifact.ownerAccountId !== accountId || artifact.access !== 'owner' || artifact.publicAudience !== 'none') continue;
        requests.set(artifact.id, { artifactId: artifact.id, serverId });
    }
    return [...requests.values()].map(request => ({ ...request,
        headerVersion: byId.get(request.artifactId)!.headerVersion, bodyVersion: byId.get(request.artifactId)!.bodyVersion,
    })).sort((left, right) => left.serverId.localeCompare(right.serverId) || left.artifactId.localeCompare(right.artifactId));
}

/** Membership alone cannot certify a count while a countable header lacks strict body admission. */
export function isInboxArtifactBodyAdmissionComplete(artifacts: readonly DecryptedArtifact[], accountId: string | null | undefined): boolean {
    for (const artifact of artifacts) {
        if (artifact.draft) continue;
        const kind = artifact.header?.kind ?? artifact.kindHint;
        // A newly admitted opaque legacy row may be an Inbox family even after
        // an earlier exact selection completed. Known other kinds stay excluded.
        if (!artifact.isDecrypted && typeof kind !== 'string') return false;
        if (typeof kind !== 'string' || !INBOX_ARTIFACT_KINDS.includes(kind)) continue;
        if (!artifact.isDecrypted || !artifact.header || artifact.header.kind !== kind) return false;
        if (approvalKinds.includes(kind)) {
            const status = kind === APPROVAL_ARTIFACT_KINDS_V1.targetAction ? TargetActionApprovalRequestV1Schema.shape.status
                : kind === APPROVAL_ARTIFACT_KINDS_V1.executionRunHostAction ? ApprovalRequestStatusSchema : ApprovalRequestV2StatusSchema;
            if (!status.safeParse(artifact.header.approvalStatus).success
                || (artifact.header.approvalStatus === 'open' && !isOpenApprovalInboxArtifact(artifact))) return false;
        } else {
            // A known foreign/shared/public notice is not this Account's Inbox. Missing authority is unknown.
            if ((artifact.ownerAccountId !== undefined && artifact.ownerAccountId !== accountId)
                || (artifact.access !== undefined && artifact.access !== 'owner')
                || (artifact.publicAudience !== undefined && artifact.publicAudience !== 'none')) continue;
            const status = kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1 ? AccountNoticeArtifactHeaderV1Schema.shape.status
                : UsageNoticeArtifactHeaderV1Schema.shape.status;
            if (!status.safeParse(artifact.header.status).success
                || (artifact.header.status === 'open' && !readAccountNoticeArtifactHeader(artifact, accountId))) return false;
        }
    }
    return true;
}
