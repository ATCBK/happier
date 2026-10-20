import type { SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { Message, TranscriptAccountActor } from '@happier-dev/session-core/messages';

/** Input transcript and turns must already belong to the exact requested Home Session. */
export function deriveTurnRequesters(turns: readonly SessionTurnV1[], messages: readonly Message[]): ReadonlyMap<string, TranscriptAccountActor | null> {
    const actorsBySeq = new Map<number, TranscriptAccountActor | null>();
    for (const message of messages) {
        if (message.kind === 'user-text' && typeof message.seq === 'number') {
            actorsBySeq.set(message.seq, message.accountActor ?? null);
        }
    }
    return new Map(turns.map((turn) => {
        const seq = turn.transcriptAnchors?.startUserMessageSeq;
        return [turn.turnId, seq === undefined ? null : actorsBySeq.get(seq) ?? null];
    }));
}
