import { approvalArtifactBodyMatchesHeaderV1, buildApprovalRequestArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { ApprovalRequestSchema, type ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { admitTargetActionApprovalTransition } from '@happier-dev/protocol/approvals/targetActionApprovalRequestTransition';
import { TargetActionApprovalRequestV1Schema, type TargetActionApprovalRequestV1 } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';

import type { ArtifactHeader, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

export type ApprovalArtifactWriteResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; errorCode: string; error: string }>;

// The one message the Artifact codec raises for a stale expected version.
const ARTIFACT_VERSION_CONFLICT_MESSAGE = 'modified by another client';

/**
 * The UI adapter of the Protocol approval subject/transition owner — the same
 * contract the CLI/daemon Artifact store enforces.
 *
 * It validates the proposed request against a fresh read of the stored one and
 * commits it with that read's versions as the Artifact CAS basis. A write that
 * lost a race therefore fails instead of landing on whatever version is newest,
 * which is what makes `approved -> executing` the single effect claim.
 */
export async function writeApprovalRequestArtifact(input: Readonly<{
    artifactId: string;
    request: ApprovalRequest | TargetActionApprovalRequestV1;
    read: (artifactId: string) => Promise<DecryptedArtifact | null>;
    /** Writes `header`/`body` with `basis`'s versions as the expected versions. */
    write: (basis: DecryptedArtifact, header: ArtifactHeader, body: string) => Promise<void>;
}>): Promise<ApprovalArtifactWriteResult> {
    const current = await input.read(input.artifactId);
    if (!current || !current.header || typeof current.body !== 'string') {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
    }
    const stored = approvalArtifactBodyMatchesHeaderV1(current.header, current.body);
    let header: ArtifactHeader;
    let request: ApprovalRequest | TargetActionApprovalRequestV1;
    const target = TargetActionApprovalRequestV1Schema.safeParse(input.request);
    if (target.success) {
        if (stored?.family !== 'target_action') {
            return { ok: false, errorCode: 'subject_mismatch', error: 'target_action_approval_subject_mismatch' };
        }
        const transition = admitTargetActionApprovalTransition(stored.request, target.data);
        if (!transition.ok) return transition;
        if (transition.unchanged) return { ok: true };
        request = target.data;
        header = buildTargetActionApprovalArtifactHeaderV1(target.data);
    } else {
        const builtIn = ApprovalRequestSchema.safeParse(input.request);
        if (stored?.family !== 'built_in' || !builtIn.success) {
            return { ok: false, errorCode: 'subject_mismatch', error: 'approval_request_subject_mismatch' };
        }
        const transition = decideApprovalRequestTransition(stored.request, builtIn.data);
        if (!transition.ok) return transition;
        if (!transition.changed) return { ok: true };
        // V1's retained Home marker is history indexing, never replay authority.
        // Preserve it from this validated CAS basis; V2 still uses its body origin.
        const legacyServerId = stored.request.v === 1 && typeof current.header.serverId === 'string'
            ? current.header.serverId : null;
        request = builtIn.data;
        header = buildApprovalRequestArtifactHeaderV1(builtIn.data, { legacyServerId });
    }
    try {
        await input.write(current, header, JSON.stringify(request));
    } catch (error) {
        if (error instanceof Error && error.message.includes(ARTIFACT_VERSION_CONFLICT_MESSAGE)) {
            return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
        }
        throw error;
    }
    return { ok: true };
}
