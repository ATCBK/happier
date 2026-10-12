import * as React from 'react';
import { isRecoveredHistoryTranscriptObservation, type Message } from '@happier-dev/session-core/messages';

import type { VoiceMarkEvent } from '@/components/voice/presence/resolveVoiceMarkPose';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { hasRetainedVoiceInputAndReply } from './voiceSetupFacts';

type FirstSuccessObservation = Readonly<{
    attemptId: string;
    conversation: SessionAddress;
    lifetime: ServerAccountScopeLifetime;
    afterSeq: number | null;
    messages: readonly Message[];
    /** Identities admitted by the local Voice input producer, not inferred from hydrated rows. */
    liveInputIds: readonly string[];
}>;

/**
 * The first-success gather (VE-01, lab SD): the setup planet's dots gather once when the first genuine
 * turn completes setup here. The acknowledged input/reply must be newer than the bound Session's
 * sequence observed at Try and include an input observed in this local attempt, in the same Account
 * lifetime. Retained completion stays readable, but
 * neither hydration nor a different conversation/attempt can turn it into a local success event.
 */
export function useVoiceSetupFirstSuccessEvent(
    firstTurnComplete: boolean,
    live: boolean,
    observation: FirstSuccessObservation | null,
): VoiceMarkEvent | null {
    const tried = React.useRef<Readonly<{
        attemptId: string;
        conversation: SessionAddress;
        lifetime: ServerAccountScopeLifetime;
        afterSeq: number;
        inputIds: Set<string>;
    }> | null>(null);
    const scope = React.useRef<FirstSuccessObservation | null>(null);
    const [event, setEvent] = React.useState<VoiceMarkEvent | null>(null);
    React.useEffect(() => {
        const previous = scope.current;
        scope.current = observation;
        if (!observation || !observation.lifetime.isCurrent()
            || (previous && (previous.lifetime !== observation.lifetime
                || previous.attemptId !== observation.attemptId
                || !areSessionAddressesEqual(previous.conversation, observation.conversation)))) {
            tried.current = null;
            setEvent(null);
        }
        if (!observation?.lifetime.isCurrent()) return;
        if (!tried.current && live && !firstTurnComplete && observation.afterSeq !== null
            && Number.isSafeInteger(observation.afterSeq) && observation.afterSeq >= 0
            && observation.conversation.serverId === observation.lifetime.scope.serverId) {
            tried.current = { attemptId: observation.attemptId, conversation: observation.conversation,
                lifetime: observation.lifetime, afterSeq: observation.afterSeq, inputIds: new Set() };
        }
        const attempt = tried.current;
        // Current canonical live projections and accepted durable Voice input retain identity
        // across End; an acknowledged row alone is not evidence that the person spoke here.
        if (attempt) for (const id of observation.liveInputIds) attempt.inputIds.add(id);
        if (!attempt || !firstTurnComplete) return;
        const observed = observation.messages.filter((message) => typeof message.seq === 'number'
            && message.seq > attempt.afterSeq && !isRecoveredHistoryTranscriptObservation(message)
            && (message.kind !== 'user-text' || attempt.inputIds.has(message.localId ?? message.id)));
        if (hasRetainedVoiceInputAndReply(observed)) {
            setEvent((current) => current ?? Object.freeze({ kind: 'gather', id: `${attempt.attemptId}:first-success` }));
        }
        // The first completion transition is consumed even when it came from historical rows.
        // Later turns cannot celebrate an already-complete setup.
        tried.current = null;
    }, [firstTurnComplete, live, observation]);
    return observation?.lifetime.isCurrent() && scope.current?.lifetime === observation.lifetime
        && areSessionAddressesEqual(scope.current.conversation, observation.conversation)
        && event?.id === `${observation.attemptId}:first-success` ? event : null;
}
