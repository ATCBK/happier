import type { SessionPersonalAttentionReasonV1 } from '@happier-dev/protocol/sessions/personal/attention';
import {
    SESSION_LIST_BACKGROUND_WORK_ATTENTION_MODE_VALUES,
    type SessionListBackgroundWorkAttentionMode,
} from '@happier-dev/protocol/account/settings/accountSettings';

export { SESSION_LIST_BACKGROUND_WORK_ATTENTION_MODE_VALUES };
export type { SessionListBackgroundWorkAttentionMode };

export function normalizeSessionListBackgroundWorkAttentionMode(value: unknown): SessionListBackgroundWorkAttentionMode {
    return value === 'showUnread' || value === 'keepWorkingUnread' ? value : 'keepWorking';
}

/** Unread presentation includes an unseen completion without rewriting the transcript read fact. */
export function hasSessionListUnreadAttention(input: Readonly<{
    hasUnreadMessages: boolean;
    personalAttentionReason?: SessionPersonalAttentionReasonV1 | null;
}>): boolean {
    return input.hasUnreadMessages || input.personalAttentionReason === 'ready_after_read';
}

/**
 * Shared by placement and row presentation, after actionable requests and failures.
 * A foreground reply can be unread while background work continues; it cannot
 * establish that the session's work is ready for review.
 */
export function resolveSessionListBackgroundWorkAttention(input: Readonly<{
    backgroundActive: boolean;
    hasUnreadMessages: boolean;
    mode?: SessionListBackgroundWorkAttentionMode;
}>): Readonly<{ placement: 'working' | 'unread'; attentionState: 'thinking' | 'unread' }> | null {
    if (!input.backgroundActive) return null;
    const presentsUnread = input.hasUnreadMessages && (input.mode === 'showUnread' || input.mode === 'keepWorkingUnread');
    return {
        placement: input.mode === 'showUnread' && presentsUnread ? 'unread' : 'working',
        attentionState: presentsUnread ? 'unread' : 'thinking',
    };
}
