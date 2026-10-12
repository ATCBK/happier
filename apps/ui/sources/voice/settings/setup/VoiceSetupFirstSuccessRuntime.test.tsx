/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';

import { renderScreen } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createSessionMessagesFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL } from '@/components/voice/attempt/useVoiceAttemptControl';
import { VoiceComposerPlanet } from '@/components/voice/composer/VoiceComposerPlanet';
import { VoiceMarkArt } from '@/components/voice/presence/VoiceMark';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { getVoiceSessionPresentedAttemptId, resetVoiceSessionRuntimeStateForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { beginCanonicalVoiceTranscriptAttempt, projectCanonicalVoiceTranscriptEvent, releaseCanonicalVoiceTranscriptConversation } from '@/voice/transcript/voiceConversationTranscript';
import { deriveCanonicalVoiceTranscriptEntryId, type CanonicalVoiceTranscriptAttempt } from '@/voice/transcript/canonicalProjector';
import { submitDurableVoiceTextTurn } from '@/voice/binding/sendVoiceSessionComposerText';

import { VoiceSetupFirstSuccessRuntime } from './VoiceSetupFirstSuccessRuntime';
import { VoiceSetupPanel } from './VoiceSetupPanel';
import { useVoiceSetupConversationMessages } from './useVoiceSetupItem';
import { deriveVoiceSetupFacts } from './voiceSetupFacts';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

it.each([
    { source: 'canonical', endBeforeReply: false, restartBeforeInput: false },
    { source: 'canonical', endBeforeReply: true, restartBeforeInput: false },
    { source: 'durable', endBeforeReply: false, restartBeforeInput: false },
    { source: 'durable', endBeforeReply: true, restartBeforeInput: false },
    { source: 'canonical', endBeforeReply: true, restartBeforeInput: true },
] as const)('publishes one observed $source completion to real setup and composer consumers (reply after End: $endBeforeReply, second Try: $restartBeforeInput)', async ({ source, endBeforeReply, restartBeforeInput }) => {
    const initial = storage.getState();
    const locks = installWebLockManagerMock();
    const artifact = createHomeHubArtifactHttpBoundary('completion-account');
    await import('@/sync/syncEngine');
    const connection = await restoreServerAccountForTest({ serverUrl: 'https://voice-completion.example.test',
        accountId: 'completion-account', credentialScope: 'restored-home', request: artifact.request });
    const scope = { serverId: connection.home.id, accountId: 'completion-account' };
    const conversation = { serverId: connection.home.id, sessionId: 'conversation' };
    const binding = { adapterId: 'local_conversation', controlSessionId: 'control', conversationSessionId: conversation.sessionId,
        conversationSessionAddress: conversation, transcriptMode: 'synthetic' as const, lifetime: 'runtime_attempt' as const,
        targetSessionAddress: null, updatedAt: 1 };
    const meta = { happier: { kind: 'conversation_turn.v1', payload: { v: 1 },
        conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice' } } } as const;
    let messages: readonly Message[] = [
        { kind: 'user-text', id: 'input', localId: 'voice-realtime:current:user:input', seq: 11, createdAt: 1, text: 'hello', meta },
        { kind: 'agent-text', id: 'reply', localId: 'voice-realtime:current:assistant:reply', seq: 12, createdAt: 2, text: 'Hi', meta },
    ];
    let canonicalAttempt: CanonicalVoiceTranscriptAttempt | null = null;
    const publish = (rows: readonly Message[]) => storage.setState((state) => ({
        sessionMessages: { ...state.sessionMessages, conversation: createSessionMessagesFixture({ isLoaded: true,
            messageIdsOldestFirst: rows.map((row) => row.id), messagesById: Object.fromEntries(rows.map((row) => [row.id, row])) }) },
    }));
    function Scene() {
        const control = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
        const setupControl = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
        const { messages: retained } = useVoiceSetupConversationMessages(conversation);
        const facts = deriveVoiceSetupFacts({ providerId: 'local_conversation', readiness: null,
            microphonePermission: 'unknown', messages: retained });
        return <>
            <VoiceSetupFirstSuccessRuntime />
            <VoiceSetupPanel testID="setup" model={{ facts, serviceTitle: null, serviceTiles: [], readiness: null,
                tryLive: setupControl.live, shortcutLabel: null, firstSuccess: setupControl.firstSuccessEvent }}
                actions={{ onSelectService() {}, onRecover() {}, onAllowMicrophone() {}, onOpenSystemSettings: null,
                    onTry() {}, onDone() {}, onOpenSettings() {}, onClose() {} }} />
            <VoiceComposerPlanet pose="ready" muted={false} markEvent={control.markEvent}
                accessibilityLabel="Voice" accessibilityHint="Voice" onPress={() => {}} />
        </>;
    }
    let screen: Awaited<ReturnType<typeof renderScreen>> | null = null;
    try {
        storage.setState({ isDataReady: true, profileScope: scope, settingsScope: scope,
            sessions: { conversation: createSessionFixture({ id: 'conversation', serverId: scope.serverId, seq: 10 }) } });
        publish([]);
        if (source === 'canonical') canonicalAttempt = beginCanonicalVoiceTranscriptAttempt({ conversationSessionId: conversation.sessionId });
        setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
        screen = await renderScreen(<InjectedAuthProvider credentials={connection.credentials}><Scene /></InjectedAuthProvider>);
        await act(async () => {
            voiceSessionBindingStore.getState().bind(binding);
            setVoiceSessionSnapshot({ adapterId: binding.adapterId, sessionId: binding.controlSessionId,
                status: 'connected', mode: 'listening', canStop: true }, binding, { accountScope: scope, conversationScope: { kind: 'voice_home' } });
        });
        if (restartBeforeInput) await act(async () => {
            setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            if (!canonicalAttempt) throw new Error('Expected canonical attempt');
            await releaseCanonicalVoiceTranscriptConversation({ conversationSessionId: conversation.sessionId,
                attemptIdentity: canonicalAttempt.attemptIdentity });
            canonicalAttempt = beginCanonicalVoiceTranscriptAttempt({ conversationSessionId: conversation.sessionId });
            setVoiceSessionSnapshot({ adapterId: binding.adapterId, sessionId: binding.controlSessionId,
                status: 'connected', mode: 'listening', canStop: true }, binding, { accountScope: scope, conversationScope: { kind: 'voice_home' } });
        });
        await act(async () => {
            if (source === 'canonical') {
                if (!canonicalAttempt) throw new Error('Expected canonical attempt');
                messages = messages.map((message) => ({ ...message, localId: deriveCanonicalVoiceTranscriptEntryId({
                    attemptIdentity: canonicalAttempt!.attemptIdentity, role: message.kind === 'user-text' ? 'user' : 'assistant',
                    itemId: message.kind === 'user-text' ? 'input' : 'reply',
                }) }));
                expect(projectCanonicalVoiceTranscriptEvent({ conversationSessionId: conversation.sessionId,
                    event: { v: 1, type: 'voice.transcript.updated', epoch: canonicalAttempt.epoch, sequence: 1,
                        revision: 1, eventId: 'input-live', itemId: 'input', role: 'user', text: 'hello', provenance: 'live' } })?.status).toBe('applied');
            } else {
                messages = messages.map((message) => ({ ...message,
                    localId: message.kind === 'user-text' ? 'durable-current-input' : 'durable-current-reply',
                    meta: { happier: { kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 1, voiceAgentId: 'current-agent',
                        role: message.kind === 'user-text' ? 'user' : 'assistant', ts: message.createdAt } } },
                }));
                await submitDurableVoiceTextTurn({ conversationSessionId: conversation.sessionId, text: 'hello',
                    localId: 'durable-current-input', pendingPort: {
                        // Persistent pending delivery and daemon acceptance are genuine external boundaries.
                        enqueuePendingMessage: async ({ localId }) => ({ localId, accepted: true, externalHandoffClaimed: true }),
                        blockPendingDelivery: async () => {}, markPendingDeliveryHandled: async () => {},
                    }, dispatch: async ({ onAccepted }) => { await onAccepted(); } });
            }
        });
        if (!restartBeforeInput) await act(async () => publish([messages[0]!]));
        const events = () => screen!.findAllByType(VoiceMarkArt).map((mark) => mark.props.event);
        expect(events()).toEqual([null, null]);
        const attemptId = getVoiceSessionPresentedAttemptId();
        if (endBeforeReply) await act(async () => {
            setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
            voiceSessionBindingStore.getState().unbind(conversation.sessionId);
            if (canonicalAttempt) await releaseCanonicalVoiceTranscriptConversation({ conversationSessionId: conversation.sessionId,
                attemptIdentity: canonicalAttempt.attemptIdentity });
        });
        await act(async () => publish(messages));
        const completed = events();
        expect(completed).toEqual([{ kind: 'gather', id: `${attemptId}:first-success` }, { kind: 'gather', id: `${attemptId}:first-success` }]);
        await act(async () => publish([...messages]));
        expect(events()[0]).toBe(completed[0]);
        expect(events()[1]).toBe(completed[1]);
    } finally {
        await screen?.unmount();
        if (canonicalAttempt) await releaseCanonicalVoiceTranscriptConversation({
            conversationSessionId: conversation.sessionId, attemptIdentity: canonicalAttempt.attemptIdentity,
        });
        voiceSessionBindingStore.getState().unbind(conversation.sessionId);
        await resetVoiceSessionRuntimeStateForTests();
        await connection.dispose();
        locks.restore();
        storage.setState(initial, true);
    }
});
