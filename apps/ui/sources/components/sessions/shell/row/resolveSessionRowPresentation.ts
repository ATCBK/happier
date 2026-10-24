import type { SessionListAttentionState } from '@/sync/domains/session/listing/deriveSessionListActivity';
import type { SessionListSecondaryLineMode } from '../../../../sync/domains/session/listing/deriveSessionListActivity';

export type SessionRowAttentionState =
    | 'quiet'
    | 'attention'
    | 'mentioned'
    | 'unread'
    | 'pending'
    | 'working'
    | 'ready'
    | 'failed'
    | 'permission_required'
    | 'action_required';

export type SessionRowDensity = 'default' | 'compact' | 'minimal';
export type SessionRowAttentionIndicator = 'none' | 'working' | 'ready' | 'failed' | 'attention' | 'unread' | 'pending' | 'permission' | 'action' | 'standing';
export type SessionRowTitleTone = 'quiet' | 'normal' | 'emphasized';
export type SessionRowSecondaryLine = 'none' | 'path' | 'status';

export type SessionRowStatusTextKey =
    | 'status.readyForReview'
    | 'status.error'
    | 'status.backgroundActive'
    | 'status.keptInAttention';

/**
 * The row's own words for a state it otherwise only draws as a coloured marker.
 *
 * `statusTextKey` is what the row *writes*; this is what the row *says*. They are the same thing
 * wherever the row already prints a sentence, and they differ exactly where it does not: a minimal
 * row draws no secondary line at all, and unread/queued-input rows never had one in any density.
 * Those rows were announced as the bare Session name, so a screen-reader user could not tell a
 * quiet Session from one holding their unread work — the marker is hidden from accessibility on
 * purpose, which leaves this projection as the only place the state can be said out loud.
 */
export type SessionRowAccessibilityStatusTextKey =
    | SessionRowStatusTextKey
    | 'status.unread'
    | 'status.mentioned'
    | 'status.queuedInput'
    | 'workStatus.buckets.needs_you';

export type SessionRowPresentation = Readonly<{
    attentionIndicator: SessionRowAttentionIndicator;
    titleTone: SessionRowTitleTone;
    secondaryLine: SessionRowSecondaryLine;
    statusTextKey?: SessionRowStatusTextKey;
    accessibilityStatusTextKey?: SessionRowAccessibilityStatusTextKey;
}>;

export function resolveSessionRowAttentionState(
    attentionState: SessionListAttentionState,
): SessionRowAttentionState {
    if (attentionState === 'thinking') return 'working';
    // The row has no usage-limit marker of its own; it reads as a non-urgent look-here marker.
    if (attentionState === 'usage_limited') return 'attention';
    return attentionState;
}

export function resolveSessionRowPresentation(input: Readonly<{
    attentionState: SessionRowAttentionState;
    density: SessionRowDensity;
    requestedSecondaryLineMode: SessionListSecondaryLineMode;
    hasPathSubtitle: boolean;
    backgroundActive?: boolean;
    /**
     * Attention standing: the person asked for this session to stay in Needs
     * attention, so it sits there with nothing of its own to say. It is a
     * separate input rather than an attention state on purpose — standing says
     * nothing about whether the session was read, and must not colour the title
     * or the badge the way unread does.
     */
    standing?: boolean;
}>): SessionRowPresentation {
    // Background activity only speaks for a row with nothing of its own to say:
    // a reply, a finished turn, queued input or a request keeps its own marker.
    const backgroundSpeaks = input.backgroundActive === true && input.attentionState === 'quiet';
    const signalIndicator = resolveAttentionIndicator(input.attentionState, backgroundSpeaks);
    // Standing is the weakest thing a row can say, so it only speaks for a row
    // that has no signal of its own: anything the session is actually doing —
    // unread, ready, working, failed, permission, action — keeps the row.
    const presentsStanding = input.standing === true && signalIndicator === 'none';
    const attentionIndicator: SessionRowAttentionIndicator = presentsStanding ? 'standing' : signalIndicator;
    const titleTone = input.attentionState === 'quiet'
        ? 'quiet'
        : signalIndicator === 'none'
            ? 'normal'
            : 'emphasized';
    const accessibilityStatusTextKey = resolveAccessibilityStatusTextKey({
        attentionState: input.attentionState,
        backgroundSpeaks,
        presentsStanding,
    });
    const spoken = accessibilityStatusTextKey ? { accessibilityStatusTextKey } : {};

    if (input.density === 'minimal') {
        // A minimal row draws no secondary line, but the marker still needs the
        // key: it is what the row is announced with.
        return presentsStanding
            ? { attentionIndicator, titleTone, secondaryLine: 'none', statusTextKey: 'status.keptInAttention', ...spoken }
            : { attentionIndicator, titleTone, secondaryLine: 'none', ...spoken };
    }

    if (input.attentionState === 'failed') {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.error', ...spoken };
    }

    if (
        input.attentionState === 'working'
        || input.attentionState === 'permission_required'
        || input.attentionState === 'action_required'
    ) {
        return { attentionIndicator, titleTone, secondaryLine: 'status', ...spoken };
    }

    if (input.attentionState === 'ready') {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.readyForReview', ...spoken };
    }

    if (input.backgroundActive === true) {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.backgroundActive', ...spoken };
    }

    if (presentsStanding) {
        return { attentionIndicator, titleTone, secondaryLine: 'status', statusTextKey: 'status.keptInAttention', ...spoken };
    }

    if (input.requestedSecondaryLineMode === 'path' && input.hasPathSubtitle) {
        return { attentionIndicator, titleTone, secondaryLine: 'path', ...spoken };
    }

    return { attentionIndicator, titleTone, secondaryLine: 'none', ...spoken };
}

/**
 * The key a row falls back to when it has a marker but no sentence.
 *
 * `undefined` means the row's own status line already states the fact in richer words (working,
 * permission, action, background activity and every unreadable-content state reach the reader
 * through `statusLineText`), so adding a second phrasing here would create two vocabularies for
 * one state.
 */
function resolveAccessibilityStatusTextKey(input: Readonly<{
    attentionState: SessionRowAttentionState;
    backgroundSpeaks: boolean;
    presentsStanding: boolean;
}>): SessionRowAccessibilityStatusTextKey | undefined {
    if (input.presentsStanding) return 'status.keptInAttention';
    if (input.backgroundSpeaks) return undefined;
    switch (input.attentionState) {
        case 'failed':
            return 'status.error';
        case 'ready':
            return 'status.readyForReview';
        // A mention shares the unread marker but never its words: a row that
        // only says "unread" cannot tell a reader somebody asked them something.
        case 'mentioned':
            return 'status.mentioned';
        case 'unread':
            return 'status.unread';
        case 'pending':
            return 'status.queuedInput';
        case 'attention':
            return 'workStatus.buckets.needs_you';
        case 'working':
        case 'permission_required':
        case 'action_required':
        case 'quiet':
            return undefined;
    }
}

function resolveAttentionIndicator(
    attentionState: SessionRowAttentionState,
    backgroundSpeaks: boolean,
): SessionRowAttentionIndicator {
    if (backgroundSpeaks) return 'working';

    switch (attentionState) {
        case 'working':
            return 'working';
        case 'ready':
            return 'ready';
        case 'failed':
            return 'failed';
        case 'attention':
            return 'attention';
        case 'mentioned':
        case 'unread':
            return 'unread';
        case 'pending':
            return 'pending';
        case 'permission_required':
            return 'permission';
        case 'action_required':
            return 'action';
        case 'quiet':
            return 'none';
    }
}
