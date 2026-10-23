import {
    readSessionAwarenessPresentationRankV1,
    SessionAwarenessPresentationStateV1Schema,
} from '@happier-dev/protocol/sessions/awareness/presentationV1';
import type { HappierWorkStatusPresentation } from '@happier-dev/plugin-ui/presentation';

/** Group urgency delegates Session states to Protocol, retaining distinct domain outcomes. */
export function readWorkStatusPresentationRank(status: HappierWorkStatusPresentation): number {
    // A seen Run retains its Failed history; only its unseen rose occurrence has failure urgency.
    if (status.state === 'failed' && status.tone !== 'danger') return status.bucket === 'needs_you' ? 8 : 3;
    const sessionState = SessionAwarenessPresentationStateV1Schema.safeParse(status.state);
    if (sessionState.success) return readSessionAwarenessPresentationRankV1(sessionState.data);
    if (status.tone === 'danger') return 10;
    if (status.bucket === 'needs_you') return 8;
    if (status.bucket === 'working') return 7;
    if (status.bucket === 'offline') return 4;
    if (status.bucket === 'finished') return 3;
    return 0;
}
