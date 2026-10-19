import type { Message } from '@happier-dev/session-core/messages';
import { readConversationTurnOriginV1FromMessageMeta } from '@happier-dev/protocol/messages/structured/conversationTurnOriginV1';
import { readVoiceAgentTurnPayloadFromMeta } from '@happier-dev/protocol/messages/structured/voiceAgentTurnLocalId';
import type { MicrophonePermissionState } from '@/utils/platform/microphonePermissions';
import type { VoiceRoleReadiness } from '@/voice/registry/readiness';
import { readCanonicalVoiceTranscriptAttemptKey } from '@/voice/transcript/canonicalProjector';

export type VoiceSetupInput = Readonly<{
    providerId: string | null;
    readiness: VoiceRoleReadiness | null;
    microphonePermission: MicrophonePermissionState;
    messages: readonly Message[];
}>;
export type VoiceSetupStepState = 'done' | 'current' | 'upcoming' | 'blocked' | 'working';

/** Facts only: no acquisition, provider calls, timers or persisted step state. */
export function deriveVoiceSetupFacts(input: VoiceSetupInput) {
    const serviceSelected = Boolean(input.providerId && input.providerId !== 'off');
    const infrastructureReady = serviceSelected && input.readiness?.status === 'ready'
        && input.readiness.providerId === input.providerId;
    const microphoneGranted = input.microphonePermission === 'granted';
    const firstTurnComplete = hasRetainedVoiceInputAndReply(input.messages);
    const observedSteps = [
        { id: 'service', done: serviceSelected },
        { id: 'readiness', done: infrastructureReady },
        { id: 'microphone', done: microphoneGranted },
        { id: 'first_turn', done: firstTurnComplete },
    ] as const;
    const currentIndex = observedSteps.findIndex((step) => !step.done);
    const steps = observedSteps.map((step, index) => {
        const state: VoiceSetupStepState = step.done ? 'done' : index !== currentIndex ? 'upcoming'
            : step.id === 'readiness' && input.readiness?.status === 'installing' ? 'working'
                : (step.id === 'readiness' && input.readiness && input.readiness.status !== 'ready')
                    || (step.id === 'microphone' && (input.microphonePermission === 'denied' || input.microphonePermission === 'unavailable'))
                    ? 'blocked' : 'current';
        return { ...step, state };
    });
    const doneCount = observedSteps.filter((step) => step.done).length;
    const complete = doneCount === observedSteps.length;
    return { steps, doneCount, total: observedSteps.length, selectedServiceId: input.providerId,
        readiness: input.readiness, canTry: infrastructureReady, firstTurnComplete, complete,
        // Which microphone fact blocks the step: a denial and a missing device recover differently.
        microphonePermission: input.microphonePermission };
}

export function hasRetainedVoiceInputAndReply(messages: readonly Message[]): boolean {
    const attempts = new Map<string, { inputSeq: number | null; replySeq: number | null }>();
    let localCaptureInputSeq: number | null = null;
    let localAgentReplySeq: number | null = null;
    for (const message of messages) {
        const seq = message.seq;
        if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) continue;
        if (message.kind !== 'user-text' && message.kind !== 'agent-text') continue;
        if (!message.text.trim() || (message.kind === 'agent-text' && message.isThinking)) continue;
        const origin = readConversationTurnOriginV1FromMessageMeta(message.meta);
        const agentTurn = readVoiceAgentTurnPayloadFromMeta(message.meta);
        if ((origin?.channel !== 'realtime_conversation' || origin.modality !== 'voice') && !agentTurn) continue;
        const role = message.kind === 'user-text' ? 'user' : 'assistant';
        const id = message.localId ?? message.id;
        const retainedAttempt = readCanonicalVoiceTranscriptAttemptKey(id, role);
        if (id.startsWith('voice-realtime:') && !retainedAttempt) continue;
        // Local capture commits the ordinary Voice-marked user row before the
        // daemon run exists. Its reply carries the run's voice_agent_turn.v1,
        // not a realtime attempt id. Acknowledged order in this conversation is
        // their shared provenance; never bridge a different realtime attempt.
        if (!retainedAttempt && !agentTurn && role === 'user') {
            localCaptureInputSeq = Math.min(localCaptureInputSeq ?? seq, seq);
        }
        if (!retainedAttempt && agentTurn?.role === 'assistant' && role === 'assistant') {
            localAgentReplySeq = Math.max(localAgentReplySeq ?? seq, seq);
        }
        const key = retainedAttempt ? `realtime:${retainedAttempt}` : agentTurn
            ? JSON.stringify(['agent', agentTurn.voiceAgentId, agentTurn.epoch])
            // Predecessor Voice rows have no canonical attempt local id. Their
            // genuine Voice provenance + acknowledged input-before-reply remain readable.
            : JSON.stringify(['predecessor', origin?.source ?? null]);
        const attempt = attempts.get(key) ?? { inputSeq: null, replySeq: null };
        if (role === 'user') attempt.inputSeq = Math.min(attempt.inputSeq ?? seq, seq);
        else attempt.replySeq = Math.max(attempt.replySeq ?? seq, seq);
        attempts.set(key, attempt);
    }
    return (localCaptureInputSeq !== null && localAgentReplySeq !== null && localAgentReplySeq > localCaptureInputSeq)
        || [...attempts.values()].some(({ inputSeq, replySeq }) => inputSeq !== null && replySeq !== null && replySeq > inputSeq);
}

export type VoiceSetupFacts = ReturnType<typeof deriveVoiceSetupFacts>;
