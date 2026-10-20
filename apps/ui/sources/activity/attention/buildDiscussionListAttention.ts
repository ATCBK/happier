import type { DiscussionOpenedSummaryV1 } from '@happier-dev/protocol/discussions/actions';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { readOpenApprovalDiscussionAttention } from '@/sync/domains/artifacts/approvalArtifacts';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

export type DiscussionListAttention = Readonly<{
    attentionReason: 'draft_waiting' | 'approval_pending' | 'mentioned' | null;
    approvalArtifactIds: readonly string[];
    /** Other Homes' private Artifact inventory is never interpreted as an empty approval set. */
    approvalAttentionAvailable: boolean;
}>;
export type DiscussionListRow = DiscussionOpenedSummaryV1 & DiscussionListAttention;

/** Transient list projection over the Inbox approval owner and the established private mention cursor. */
export function buildDiscussionListAttention<T extends Pick<DiscussionOpenedSummaryV1, 'id' | 'unreadMentionCount'>>(input: Readonly<{
    scope: ServerAccountScope;
    artifactScope: ServerAccountScope | null;
    artifactsLoaded: boolean;
    artifacts: readonly DecryptedArtifact[];
    items: readonly T[];
}>, previous: readonly (T & DiscussionListAttention)[] = []): readonly (T & DiscussionListAttention)[] {
    const available = input.artifactsLoaded && areServerAccountScopesEqual(input.scope, input.artifactScope);
    const approvals = new Map<string, string[]>();
    const drafts = new Set<string>();
    if (available) for (const artifact of input.artifacts) {
        const address = readOpenApprovalDiscussionAttention(artifact);
        if (!address || !areServerProfileIdentifiersEquivalent(address.serverId, input.scope.serverId)) continue;
        const ids = approvals.get(address.discussionId) ?? [];
        ids.push(artifact.id);
        approvals.set(address.discussionId, ids);
        if (address.reason === 'draft_waiting') drafts.add(address.discussionId);
    }
    const before = new Map(previous.map(row => [row.id, row]));
    const rows = input.items.map(item => {
        const ids = approvals.get(item.id) ?? [];
        const attentionReason: DiscussionListAttention['attentionReason'] = drafts.has(item.id) ? 'draft_waiting' : ids.length ? 'approval_pending'
            : item.unreadMentionCount > 0 ? 'mentioned' : null;
        const old = before.get(item.id);
        if (old && old.attentionReason === attentionReason && old.approvalAttentionAvailable === available
            && old.approvalArtifactIds.length === ids.length && old.approvalArtifactIds.every((id, index) => id === ids[index])
            && Object.entries(item).every(([key, value]) => Reflect.get(old, key) === value)) return old;
        return { ...item, attentionReason, approvalArtifactIds: ids, approvalAttentionAvailable: available };
    });
    return previous.length === rows.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}
