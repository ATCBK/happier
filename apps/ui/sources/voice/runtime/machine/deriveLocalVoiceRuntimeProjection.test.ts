import { beforeEach, describe, expect, it } from 'vitest';

import { deriveLocalVoiceSessionSnapshot } from './deriveLocalVoiceSessionSnapshot';
import { createVoiceConversationRuntimeMachine } from './VoiceConversationRuntimeMachine';
import { createVoiceMachineError } from './voiceMachineError';
import { createVoiceContinuationProjection } from '@/voice/transcript/voiceContinuationProjection';
import type { VoiceSessionBinding } from '@/voice/binding/voiceConversationBindingTypes';

describe('local teardown projection', () => {
    beforeEach(() => createVoiceConversationRuntimeMachine().reset());

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

    it('does not publish a continuation when dismissing a failed same-target restart', () => {
        const machine = createVoiceConversationRuntimeMachine();
        const continuation = createVoiceContinuationProjection();
        const controlSessionId = 'retained-control';
        const binding: VoiceSessionBinding = {
            adapterId: 'local_conversation', controlSessionId,
            conversationSessionId: 'retained-carrier',
            conversationSessionAddress: { serverId: 'home', sessionId: 'retained-carrier' },
            transcriptMode: 'synthetic', targetSessionAddress: null, updatedAt: 1,
        };
        const publish = () => continuation.update({
            snapshot: deriveLocalVoiceSessionSnapshot('local_conversation', 'local', machine.getSnapshot()),
            binding, deviceId: 'this-device', sessionSeq: 3,
        });

        machine.transitionToConnecting({ controlSessionId });
        expect(publish()).toBeNull();
        machine.transitionToListening({ controlSessionId });
        const firstConnection = publish();
        expect(firstConnection?.continuation.conversation).toEqual(binding.conversationSessionAddress);
        if (!firstConnection) throw new Error('Expected an acknowledged first connection');
        continuation.settle(firstConnection, true);
        machine.transitionToEnding({ controlSessionId });
        expect(deriveLocalVoiceSessionSnapshot('local_conversation', 'local', machine.getSnapshot()))
            .toMatchObject({ status: 'connected', canStop: true });
        expect(publish()).toBeNull();
        machine.transitionToDisconnected({ controlSessionId });
        expect(publish()).toBeNull();

        machine.transitionToConnecting({ controlSessionId });
        expect(publish()).toBeNull();
        machine.setError({ controlSessionId, error: createVoiceMachineError({
            kind: 'provider_error', reason: 'RPC_OUTCOME_UNKNOWN',
        }) });
        expect(publish()).toBeNull();
        // Dismiss reuses Stop: failed -> ending, without a connection acknowledgement.
        machine.transitionToEnding({ controlSessionId });
        expect(publish()).toBeNull();
        expect(deriveLocalVoiceSessionSnapshot('local_conversation', 'local', machine.getSnapshot()))
            .toMatchObject({ status: 'connecting', canStop: true });
        machine.transitionToEnding({ controlSessionId });
        expect(publish()).toBeNull();
        machine.transitionToDisconnected({ controlSessionId });
        expect(publish()).toBeNull();

        machine.transitionToConnecting({ controlSessionId });
        expect(publish()).toBeNull();
        machine.transitionToListening({ controlSessionId });
        const reconnected = publish();
        expect(reconnected?.localId).toBeDefined();
        expect(reconnected?.localId).not.toBe(firstConnection.localId);
    });

    it.each(['connecting', 'acquiring_mic', 'mic_error', 'disconnected'] as const)(
        'keeps Stop without inventing a connection when retiring %s', async (state) => {
            const machine = createVoiceConversationRuntimeMachine();
            const controlSessionId = 'unconnected';
            machine.transitionToConnecting({ controlSessionId });
            if (state === 'acquiring_mic') machine.transitionToAcquiringMic({ controlSessionId });
            if (state === 'mic_error') await machine.rearmListening({ controlSessionId,
                startListening: async () => { throw new Error('permission_denied'); },
            });
            if (state === 'disconnected') machine.transitionToDisconnected({ controlSessionId });
            machine.transitionToEnding({ controlSessionId });
            expect(deriveLocalVoiceSessionSnapshot('local_conversation', 'local', machine.getSnapshot()))
                .toMatchObject({ status: 'connecting', canStop: true });
        },
    );
});
