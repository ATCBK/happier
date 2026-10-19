import { beforeEach, describe, expect, it } from 'vitest';

import { voiceConversationRuntimeMachine } from './VoiceConversationRuntimeMachine';
import { createVoiceMachineError } from './voiceMachineError';

describe('voiceConversationRuntimeHelpers', () => {
    beforeEach(() => {
        voiceConversationRuntimeMachine.reset();
    });

    it('confirms voice capture start through the machine listening transition', async () => {
        const { confirmVoiceCaptureStarted } = await import('./voiceConversationRuntimeHelpers');

        voiceConversationRuntimeMachine.transitionToAcquiringMic({
            controlSessionId: 's1',
        });
        confirmVoiceCaptureStarted('s1');

        expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'listening',
            error: null,
        });
    });

    it('surfaces capture errors onto disconnected runtime state carrying the error', async () => {
        const { surfaceRecoverableVoiceCaptureError } = await import('./voiceConversationRuntimeHelpers');

        const original = {
            controlSessionId: 's1',
            reason: 'device_stt_start_failed',
        };
        const privateCause = new Error('private native transport failure');
        Object.defineProperty(original, 'cause', { value: privateCause, enumerable: false });
        surfaceRecoverableVoiceCaptureError(original);

        expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'disconnected',
            error: {
                kind: 'provider_error',
                reason: 'device_stt_start_failed',
                recoverable: true,
            },
        });
        const error = voiceConversationRuntimeMachine.getSnapshot().error;
        expect(error).toHaveProperty('cause', privateCause);
        expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false);
        expect(JSON.stringify(error)).not.toContain('private native transport failure');
    });

    it('maps idle-without-error transitions onto the idle, mic-off connected runtime state', async () => {
        const { transitionVoiceRuntimeToIdle } = await import('./voiceConversationRuntimeHelpers');

        transitionVoiceRuntimeToIdle({
            controlSessionId: 's1',
        });

        expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'connected',
            error: null,
        });
    });

    it('ignores late capture-start confirmation after rearm timeout already moved the machine into stt_timeout', async () => {
        const { confirmVoiceCaptureStarted } = await import('./voiceConversationRuntimeHelpers');

        voiceConversationRuntimeMachine.setError({
            controlSessionId: 's1',
            error: createVoiceMachineError({ kind: 'stt_timeout', reason: 'listening_start_timeout' }),
        });

        confirmVoiceCaptureStarted('s1');

        expect(voiceConversationRuntimeMachine.getSnapshot()).toMatchObject({
            controlSessionId: 's1',
            state: 'error',
            error: {
                kind: 'stt_timeout',
                reason: 'listening_start_timeout',
                recoverable: true,
            },
        });
    });
});
