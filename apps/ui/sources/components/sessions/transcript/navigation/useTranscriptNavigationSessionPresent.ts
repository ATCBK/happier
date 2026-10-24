import * as React from 'react';

import { useSessionTranscriptSource } from '../source/SessionTranscriptSourceContext';
import { readSessionAwarenessPresentationV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';

/**
 * What the Navigate pane needs to know about the session's present, from the canonical awareness
 * projection (the same owner the Companion summary and the session list read):
 * - `newestTurn`: the newest turn is being worked on, or is waiting for the person;
 * - `offlineSinceMs`: the runtime is unreachable, so the list is last-known.
 */
export type TranscriptNavigationSessionPresent = Readonly<{
    newestTurn: 'working' | 'waiting' | null;
    offlineSinceMs: number | null;
    offline: boolean;
}>;

const IDLE: TranscriptNavigationSessionPresent = Object.freeze({ newestTurn: null, offlineSinceMs: null, offline: false });

export function useTranscriptNavigationSessionPresent(): TranscriptNavigationSessionPresent {
    const source = useSessionTranscriptSource();
    const awareness = source.useAwareness();
    const lastObservedAt = source.useRuntimeLastObservedAt();
    const state = awareness ? readSessionAwarenessPresentationV1(awareness) : null;
    const newestTurn = state === 'thinking' ? 'working'
        : state === 'permission_required' || state === 'action_required' ? 'waiting' : null;
    const offline = state === 'disconnected';
    const offlineSinceMs = offline ? lastObservedAt : null;
    return React.useMemo(
        () => (newestTurn === null && !offline ? IDLE : { newestTurn, offline, offlineSinceMs }),
        [newestTurn, offline, offlineSinceMs],
    );
}
