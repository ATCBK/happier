import { describe, expect, it } from 'vitest';
import { deriveTurnRequesters } from './deriveTurnRequesters';
import type { SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import type { Message, TranscriptAccountActor } from '@happier-dev/session-core/messages';

const actor: TranscriptAccountActor = { v: 1, serverId: 'home', accountId: 'alice', profile: null };
const messages: Message[] = [
    { kind: 'user-text', id: 'u1', seq: 1, localId: null, createdAt: 1, text: 'First', accountActor: actor },
    { kind: 'user-text', id: 'u2', seq: 2, localId: null, createdAt: 2, text: 'Later', accountActor: null },
];
const turn = (turnId: string, seq?: number): SessionTurnV1 => ({
    turnId, status: 'completed', startedAt: 1, updatedAt: 2,
    ...(seq === undefined ? {} : { transcriptAnchors: { startUserMessageSeq: seq } }),
});

describe('deriveTurnRequesters', () => {
    it('names the exact initiating user message and never guesses from neighboring messages', () => {
        expect([...deriveTurnRequesters([turn('first', 1), turn('later', 2), turn('missing', 3), turn('unanchored')], messages)])
            .toEqual([['first', actor], ['later', null], ['missing', null], ['unanchored', null]]);
    });
});
