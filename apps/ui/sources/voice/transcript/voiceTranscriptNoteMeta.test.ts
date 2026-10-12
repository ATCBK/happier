import { describe, expect, it } from 'vitest';
import { buildVoiceTranscriptNoteMeta, hasVoiceTranscriptNoteMeta, readVoiceContinuationProvenance } from './voiceTranscriptNoteMeta';

describe('Voice transcript note provenance', () => {
    it('retains the exact connected device and conversation on a continuation note', () => {
        const continuation = { v: 1, deviceId: 'device-b', deviceDisplayName: 'Alice’s phone', conversation: { serverId: 'home-a', sessionId: 'voice-a' } } as const;
        expect(buildVoiceTranscriptNoteMeta({ continuation })).toMatchObject({ happier: { kind: 'voice_note.v1', payload: { v: 1, continuation } } });
        expect(hasVoiceTranscriptNoteMeta(buildVoiceTranscriptNoteMeta())).toBe(true);
        expect(readVoiceContinuationProvenance(buildVoiceTranscriptNoteMeta({ continuation }))).toEqual(continuation);
    });
    it('keeps legacy notes visible but missing, malformed and future provenance cannot control capture', () => {
        expect(readVoiceContinuationProvenance(buildVoiceTranscriptNoteMeta())).toBeNull();
        const continuation = { v: 1, deviceId: 'device', conversation: { serverId: 'home', sessionId: 'conversation' } };
        for (const value of [{ ...continuation, v: 2 }, { ...continuation, deviceId: '' }]) {
            expect(readVoiceContinuationProvenance({ happier: { kind: 'voice_note.v1', payload: { v: 1, continuation: value } } })).toBeNull();
        }
    });

    it('reads retained continuation provenance without giving retired fields authority or relaxing new writes', () => {
        const continuation = { v: 1 as const, deviceId: 'device', conversation: { serverId: 'home', sessionId: 'conversation' } };
        const retained = { ...continuation, lease: 'not-an-authority', conversation: { ...continuation.conversation, remoteEnd: true } };
        expect(readVoiceContinuationProvenance({ happier: { kind: 'voice_note.v1', payload: {
            v: 1, retiredPayloadField: true, continuation: retained,
        } } })).toEqual(continuation);
        expect(() => buildVoiceTranscriptNoteMeta({ continuation: retained })).toThrow();
    });
});
