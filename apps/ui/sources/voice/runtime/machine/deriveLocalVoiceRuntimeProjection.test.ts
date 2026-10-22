import { describe, expect, it } from 'vitest';

import { deriveLocalVoiceSessionSnapshot } from './deriveLocalVoiceSessionSnapshot';

describe('local teardown projection', () => {
    it('keeps Stop available without announcing a new connection', () => {
        expect(deriveLocalVoiceSessionSnapshot('local_conversation', 'local', {
            adapterId: null,
            controlSessionId: 'ending-session',
            state: 'ending',
            micMuted: true,
            reconnecting: false,
            error: null,
        })).toMatchObject({ status: 'connected', mode: 'idle', canStop: true, micMuted: true });
    });
});
