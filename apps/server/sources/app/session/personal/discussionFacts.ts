import type { DiscussionAttentionFactsV1 } from '@happier-dev/protocol/discussions/models';
import { resolveSessionPersonalAttentionV1 } from '@happier-dev/protocol/sessions/personal/attention';

import type { Tx } from "@/storage/inTx";
import { loadDiscussionSessionFactsForAccountInTx } from "@/app/discussions/attentionFacts";

/**
 * The narrow Lane 05 discussion port, mirroring `followFacts` in shape.
 *
 * Lane 05 owns conversation storage, sequence, cursors and the bounded fact
 * queries; Lane 09B owns what those facts mean for one person. This module is
 * the only place the two meet: it turns Lane 05's counts into the content-free
 * booleans the canonical relevance and attention resolvers consume, so the
 * relational predicate and the pure projector cannot drift apart.
 */
export type SessionPersonalDiscussionFacts = Readonly<{
    /** An unread conversation beyond this Account's established private cursor. */
    hasUnread: boolean;
    /** An unread mention of this Account beyond that same cursor. */
    hasMention: boolean;
    /** A human-origin post by this Account; Agent production never qualifies. */
    authored: boolean;
    /** An existing mention of this Account, whether or not it is still unread. */
    mentioned: boolean;
}>;

export const QUIET_SESSION_PERSONAL_DISCUSSION_FACTS: SessionPersonalDiscussionFacts = Object.freeze({
    hasUnread: false,
    hasMention: false,
    authored: false,
    mentioned: false,
});

/**
 * The one counts-to-attention mapping.
 *
 * Absent facts are quiet rather than unknown: Lane 05 reports nothing for a
 * Session where this Account holds no cursor, and that is exactly the case where
 * no history may be replayed as unread.
 */
export function projectDiscussionAttentionSignals(
    facts: DiscussionAttentionFactsV1 | undefined,
): Readonly<{ hasUnread: boolean; hasMention: boolean }> {
    return {
        hasUnread: (facts?.unreadConversationCount ?? 0) > 0,
        hasMention: (facts?.unreadMentionCount ?? 0) > 0,
    };
}

/** Resource-admitted cursor facts use the same attention decision as Session rows. */
export function doesDiscussionViewerNeedAttention(facts: DiscussionAttentionFactsV1 | undefined): boolean {
    return resolveSessionPersonalAttentionV1({
        tracked: facts !== undefined,
        accessible: facts !== undefined,
        accountSuspended: false,
        contentAvailable: true,
        visibleSessionSeq: 0,
        readState: { state: 'not_started' },
        latestReadyEventSeq: null,
        hasPrimarySessionFailure: false,
        pendingBlockedCount: 0,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        capabilities: { canSubmitAgentInput: false, canApprovePermissions: false },
        responsible: false,
        discussion: projectDiscussionAttentionSignals(facts),
        attentionStanding: 'none',
        reminderDue: false,
    }).needsAttention;
}

/**
 * Loads both discussion fact families for a page of Sessions in one bounded set.
 *
 * The Discussion owner shares candidate discovery and access admission across
 * participation and unread attention. An ordinary page without Discussions
 * costs one lookup; final row projection can reuse these exact observed facts.
 */
export async function loadSessionPersonalDiscussionFactsInTx(tx: Tx, params: Readonly<{
    accountId: string;
    sessionIds: readonly string[];
}>): Promise<ReadonlyMap<string, SessionPersonalDiscussionFacts>> {
    const sessionIds = [...new Set(params.sessionIds)];
    const facts = new Map<string, SessionPersonalDiscussionFacts>();
    if (sessionIds.length === 0) return facts;

    const { participation, attention } = await loadDiscussionSessionFactsForAccountInTx(tx, {
        accountId: params.accountId,
        sessionIds,
    });
    for (const sessionId of sessionIds) {
        const signals = projectDiscussionAttentionSignals(attention?.get(sessionId));
        const participated = participation.get(sessionId);
        if (!signals.hasUnread && !signals.hasMention && !participated) continue;
        facts.set(sessionId, {
            ...signals,
            authored: participated?.humanAuthored === true,
            mentioned: participated?.mentioned === true,
        });
    }
    return facts;
}
