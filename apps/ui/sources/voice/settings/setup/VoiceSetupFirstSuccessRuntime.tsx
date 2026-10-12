import * as React from 'react';

import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useVoiceSessionSnapshot } from '@/voice/session/voiceSession';
import {
    clearVoiceSessionFirstSuccess,
    clearVoiceSessionFirstSuccessInputs,
    getVoiceSessionEndedAttempt,
    getVoiceSessionPresentedAttemptId,
    getVoiceSessionPresentedBinding,
    getVoiceSessionFirstSuccessInputIds,
    recordVoiceSessionFirstSuccess,
    subscribeToVoiceSessionEndedAttempt,
} from '@/voice/session/voiceSessionStore';

import { useVoiceSetupConversationMessages } from './useVoiceSetupItem';
import { useVoiceSetupFirstSuccessEvent } from './useVoiceSetupFirstSuccessEvent';
import { hasRetainedVoiceInputAndReply } from './voiceSetupFacts';
import { readCanonicalVoiceTranscriptSnapshot, subscribeCanonicalVoiceTranscript } from '@/voice/transcript/voiceConversationTranscript';
import { deriveCanonicalVoiceTranscriptEntryId, type CanonicalVoiceTranscriptItem } from '@/voice/transcript/canonicalProjector';

const NO_CANONICAL_ITEMS: readonly CanonicalVoiceTranscriptItem[] = Object.freeze([]);

/** Detailed transcript observation stays in this runtime leaf; every art consumer reads one attempt fact. */
export function VoiceSetupFirstSuccessRuntime(): null {
    const snapshot = useVoiceSessionSnapshot();
    useActiveServerAccountScope();
    const ended = React.useSyncExternalStore(subscribeToVoiceSessionEndedAttempt, getVoiceSessionEndedAttempt, getVoiceSessionEndedAttempt);
    const conversation = getVoiceSessionPresentedBinding()?.conversationSessionAddress ?? ended?.conversationSessionAddress ?? null;
    const attemptId = getVoiceSessionPresentedAttemptId();
    const lifetime = captureActiveServerAccountScopeLifetime();
    const acceptedInputIds = React.useSyncExternalStore(subscribeToVoiceSessionEndedAttempt,
        getVoiceSessionFirstSuccessInputIds, getVoiceSessionFirstSuccessInputIds);
    // The projector releases its listeners at End. A fresh Try must subscribe again even
    // when it reuses the same conversation, rather than relying on an old listener handle.
    const subscribe = React.useCallback((listener: () => void) => conversation && attemptId && lifetime?.isCurrent()
        ? subscribeCanonicalVoiceTranscript(conversation.sessionId, listener) : () => {},
        [conversation?.serverId, conversation?.sessionId, attemptId, lifetime]);
    const read = React.useCallback(() => conversation && attemptId && lifetime?.isCurrent() && lifetime.scope.serverId === conversation.serverId
        ? readCanonicalVoiceTranscriptSnapshot(conversation.sessionId) : NO_CANONICAL_ITEMS,
        [conversation?.serverId, conversation?.sessionId, attemptId, lifetime]);
    const canonical = React.useSyncExternalStore(subscribe, read, read);
    const liveInputIds = React.useMemo(() => [...acceptedInputIds, ...canonical
        .filter((item) => item.role === 'user' && item.provenance === 'live' && item.text.trim())
        .map(deriveCanonicalVoiceTranscriptEntryId)], [canonical, acceptedInputIds]);
    const { messages, sessionSeq } = useVoiceSetupConversationMessages(conversation);
    const complete = React.useMemo(() => hasRetainedVoiceInputAndReply(messages), [messages]);
    const observation = React.useMemo(() => conversation && attemptId && lifetime ? {
        attemptId, conversation, lifetime, messages, afterSeq: sessionSeq, liveInputIds,
    } : null, [conversation?.serverId, conversation?.sessionId, attemptId, lifetime, messages, sessionSeq, liveInputIds]);
    const event = useVoiceSetupFirstSuccessEvent(complete,
        snapshot.status === 'connecting' || snapshot.status === 'connected', observation);
    React.useEffect(() => {
        const retirement = lifetime?.onRetire(clearVoiceSessionFirstSuccess);
        return () => retirement?.dispose();
    }, [lifetime]);
    React.useEffect(() => {
        if (event && attemptId && lifetime) recordVoiceSessionFirstSuccess(attemptId, lifetime);
    }, [event, attemptId, lifetime]);
    React.useEffect(() => {
        // Once historical completion is readable, identities can no longer produce first success.
        if (complete) clearVoiceSessionFirstSuccessInputs();
    }, [complete, acceptedInputIds]);
    return null;
}
