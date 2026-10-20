import type { DiscussionAttentionResultV1 } from '@happier-dev/protocol/discussions/actions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';

export type InboxDiscussionSource = Readonly<{
    scope: ServerAccountScope;
    entries: DiscussionAttentionResultV1['discussions'];
    /** Exact-Home names from the existing batched Session title projection. */
    sessionDisplayNames?: ReadonlyMap<string, string | null>;
}>;

export type InboxItemView = 'needs_you' | 'updates' | 'mentions';
export type InboxItemType = 'decision' | 'approval' | 'blocked' | 'update' | 'mention';

export function inboxItemView(type: InboxItemType): InboxItemView {
    return type === 'mention' ? 'mentions' : type === 'update' ? 'updates' : 'needs_you';
}

/** Shared source admission; the badge needs neither thread reads nor row display joins. */
export function* admittedInboxDiscussionOccurrences(source: InboxDiscussionSource) {
    for (const { discussion, occurrences } of source.entries) {
        if (discussion.archivedAt !== null || !discussion.keyReadiness) continue;
        for (const occurrence of occurrences) {
            const { message } = occurrence;
            if (message.content === null || message.discussionId !== discussion.id
                || message.messageRef.discussion.serverId !== source.scope.serverId
                || message.messageRef.discussion.discussionId !== discussion.id) continue;
            yield { discussion, ...occurrence };
        }
    }
}
