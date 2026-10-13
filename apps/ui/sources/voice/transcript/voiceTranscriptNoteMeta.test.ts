import { describe, expect, it } from 'vitest';
import { buildVoiceTranscriptNoteMeta, hasVoiceTranscriptNoteMeta, readVoiceContinuationProvenance, VoiceTranscriptNotePayloadSchema } from './voiceTranscriptNoteMeta';

describe('Voice transcript note provenance', () => {
    it('retains the exact connected device and conversation on a continuation note', () => {
        const continuation = { v: 1, deviceId: 'device-b', deviceDisplayName: 'Alice’s phone', conversation: { serverId: 'home-a', sessionId: 'voice-a' } } as const;
        const written: unknown = JSON.parse(JSON.stringify(buildVoiceTranscriptNoteMeta({ continuation })));
        if (!written || typeof written !== 'object' || !('happier' in written)
            || !written.happier || typeof written.happier !== 'object' || !('payload' in written.happier)) {
            throw new Error('Missing persisted Voice note payload');
        }
        expect(VoiceTranscriptNotePayloadSchema.parse(written.happier.payload)).toEqual({ v: 1, continuation });
        expect(hasVoiceTranscriptNoteMeta(buildVoiceTranscriptNoteMeta())).toBe(true);
        expect(readVoiceContinuationProvenance(written)).toEqual(continuation);
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
