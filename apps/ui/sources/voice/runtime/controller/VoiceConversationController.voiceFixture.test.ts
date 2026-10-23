import { waitForTestEvent } from '@/dev/testkit';
import { readStoredSessionMessages } from '@happier-dev/session-core/messages';
import { describe, expect, it, vi } from 'vitest';

import {
  matchesVoiceFixtureTranscript,
  readVoiceFixturePcm16,
} from '../../../../../../packages/tests/src/testkit/voice/voiceFixture';
import { useVoiceConversationRuntimeStore } from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { createOpenAiVoiceRuntimeEnvironment } from '@/dev/testkit/harness/openAiVoiceRuntime';
import { installVoiceWebRtcBrowserBoundary } from '@/dev/testkit/harness/voiceWebRtcHarness';

vi.mock('socket.io-client', async importOriginal => (
  await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (
  await import('@/dev/testkit/mocks/reactNative')
).createReactNativeWebMock({ Platform: { OS: 'web' } }));
// Expo's device-owned audio-mode SDK is absent in the Node runner. The real
// Voice audio-mode lease still acquires and releases through this boundary.
vi.mock('expo-audio', async () => (
  await import('@/dev/testkit/mocks/expoAudio')
).expoAudioModuleMock());

describe('conversation controller canonical fixture consumer', () => {
  it('projects the fixture-defined two-turn sequence and settles the controller lifecycle once', async () => {
    const fixture = await readVoiceFixturePcm16('two-turns-with-pause-24k');
    const speechWindows = fixture.metadata.timelineMs.filter((entry) => entry.kind === 'speech');
    const silenceWindow = fixture.metadata.timelineMs.find((entry) => entry.kind === 'silence');
    expect(speechWindows).toHaveLength(2);
    expect(silenceWindow && silenceWindow.end - silenceWindow.start).toBeGreaterThanOrEqual(1_500);

    const turnTexts = ['Start a new session.', 'Then open the project settings.'] as const;
    const environment = await createOpenAiVoiceRuntimeEnvironment();
    const browser = installVoiceWebRtcBrowserBoundary();
    const composed = await environment.createRuntime(browser);
    const { storage } = await import('@/sync/domains/state/storage');
    const {
      readCanonicalVoiceTranscriptSnapshot,
      subscribeCanonicalVoiceTranscript,
    } = await import('@/voice/transcript/voiceConversationTranscript');
    const observations: string[] = [];
    const unsubscribeMachine = useVoiceConversationRuntimeStore.subscribe((state, previous) => {
      if (state.snapshot.state !== previous.snapshot.state) observations.push(state.snapshot.state);
    });
    let observedTurns = 0;
    const unsubscribeTranscript = subscribeCanonicalVoiceTranscript(composed.historySessionId, () => {
      const projected = readCanonicalVoiceTranscriptSnapshot(composed.historySessionId);
      for (const entry of projected.slice(observedTurns)) observations.push(`transcript:${entry.firstSequence}`);
      observedTurns = projected.length;
    });
    const persistedUserTexts = () => readStoredSessionMessages(storage.getState(), composed.historySessionId)
      .filter(message => message.kind === 'user-text')
      .map(message => message.text);

    try {
      const starting = composed.runtime.adapter.start({
        sessionId: '', requestedTargetSessionAddress: null, initialContext: '',
      });
      await Promise.resolve(browser.peerCreated().then(peer => peer.dataChannelCreated)).then(() => expect(browser.peer.createDataChannel).toHaveBeenCalledWith('oai-events'));
      browser.peer.channel.open();
      await starting;
      expect(composed.runtime.adapter.getSnapshot().status).toBe('connected');
      expect(browser.peer.addTrack).toHaveBeenCalledWith(browser.micTrack, browser.micStream);

      for (const [index, window] of speechWindows.entries()) {
        const startByte = Math.round(window.start / 1_000 * fixture.sampleRateHz) * 2;
        const endByte = Math.round(window.end / 1_000 * fixture.sampleRateHz) * 2;
        expect(fixture.pcm16Bytes.subarray(startByte, endByte).byteLength).toBeGreaterThan(0);
        // The PCM fixture defines the utterance windows and expected words.
        // Provider ASR is the external boundary; this test does not synthesize
        // audio recognition or claim physical WebRTC microphone processing.
        browser.peer.channel.message(JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          event_id: `fixture-event-${index + 1}`,
          item_id: `fixture-turn-${index + 1}`,
          transcript: turnTexts[index]!,
        }));
        await waitForTestEvent(storage.subscribe, () => expect(persistedUserTexts()).toEqual(turnTexts.slice(0, index + 1)));
      }
      const projected = readCanonicalVoiceTranscriptSnapshot(composed.historySessionId);
      expect(projected.map(event => event.text)).toEqual(turnTexts);
      expect(projected.map(event => event.firstSequence)).toEqual([1, 2]);
      expect(matchesVoiceFixtureTranscript(fixture.metadata, projected.map(event => event.text).join(' '))).toBe(true);

      await composed.runtime.adapter.stop({ sessionId: composed.controlSessionId });
      // End releases the active canonical ring; ordinary stored messages own
      // retained history. A late SDK final must neither reopen that ring nor
      // append a third durable turn.
      const stoppedProjection = readCanonicalVoiceTranscriptSnapshot(composed.historySessionId);
      browser.peer.channel.message(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        event_id: 'late-event', item_id: 'late-item', transcript: 'late output must be discarded',
      }));
      await Promise.resolve();
      expect(readCanonicalVoiceTranscriptSnapshot(composed.historySessionId)).toEqual(stoppedProjection);
      expect(persistedUserTexts()).toEqual(turnTexts);
      expect(browser.peer.channel.readyState).toBe('closed');
      expect(composed.runtime.adapter.getSnapshot().status).toBe('disconnected');
      expect(composed.controller?.getOwnedAttemptId()).toBeNull();
      expect(observations).toEqual([
        'connecting', 'acquiring_mic', 'connecting', 'connected',
        'transcript:1', 'transcript:2', 'ending', 'disconnected',
      ]);
      expect(browser.peer.close).toHaveBeenCalledOnce();
      expect(browser.micTrack.stop).toHaveBeenCalledOnce();
    } finally {
      unsubscribeTranscript();
      unsubscribeMachine();
      await composed.runtime.dispose();
      composed.hostLease.revoke();
      browser.restore();
      await environment.dispose();
    }
  });
});
