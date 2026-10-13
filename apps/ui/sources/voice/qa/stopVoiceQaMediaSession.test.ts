import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerLocalVoiceEngineHarnessHooks,
  warmLocalVoiceEngineHarnessGraph,
  localVoiceHomeId,
  getStorage,
  localVoicePendingEnqueue,
  localVoiceSpeechTranscription,
  emitSpeechRecEvent,
  speechRecStart,
  speechRecStop,
  setRecorderUri,
  loadLocalVoiceEngineWithCompatState,
} from '@/voice/local/localVoiceEngine.testHarness';
import { writeVoiceProviderSettingsConfig, readLocalConversationVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { createVoiceSessionManager } from '@/voice/session/voiceSessionManager';
import { getVoiceAdapterRegistry } from '@/voice/session/voiceAdapterRegistry';
import { localVoiceRuntimeController } from '@/voice/local/localVoiceRuntimeController';
import { stopVoiceQaMediaSession } from './stopVoiceQaMediaSession';

const restoreModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreModuleLoader());

describe('stopVoiceQaMediaSession', () => {
  let lifecycle: ReturnType<typeof createVoiceSessionLifecycleController>;
  let manager: ReturnType<typeof createVoiceSessionManager>;
  afterEach(async () => { await lifecycle?.dispose(); });
  registerLocalVoiceEngineHarnessHooks();
  beforeEach(async () => {
    await loadLocalVoiceEngineWithCompatState();
    lifecycle = createVoiceSessionLifecycleController();
    lifecycle.setConfiguredProviderId('local_conversation');
    manager = createVoiceSessionManager({ getLifecycleController: () => lifecycle });
  });

  const stop = () => stopVoiceQaMediaSession({
    sessionId: 's1',
    snapshot: manager.getSnapshot(),
    getSnapshot: manager.getSnapshot,
    resolveEngineKind: adapterId => getVoiceAdapterRegistry().get(adapterId)?.engineKind ?? null,
    toggleLocalTurn: localVoiceRuntimeController.toggleTurn,
    stopSession: manager.stop,
  });

  it('finishes a local capture turn before stopping the owning Voice session', async () => {
    localVoiceSpeechTranscription.mockResolvedValue('accepted QA input');
    await manager.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
    expect(manager.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening', sessionId: 's1' });
    await stop();
    expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
        role: 'user', content: { type: 'text', text: 'accepted QA input' },
      }) } }),
    }));
    expect(manager.getSnapshot().status).toBe('disconnected');
  });

  it('stops the terminal QA session when a completed hands-free turn has already rearmed capture', async () => {
    const storage = await getStorage();
    const voice = storage.getState().settings.voice;
    const config = readLocalConversationVoiceSettings(voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice:
      writeVoiceProviderSettingsConfig(voice, 'local_conversation', {
        ...config, handsFree: { ...config.handsFree, enabled: true,
          endpointing: { silenceMs: 0, minSpeechMs: 0 } },
        stt: { ...config.stt, provider: 'device' },
        tts: { ...config.tts, autoSpeakReplies: false },
      }),
    } });
    speechRecStart.mockImplementation(() => { emitSpeechRecEvent('start'); emitSpeechRecEvent('audiostart'); });
    speechRecStop.mockImplementation(() => { emitSpeechRecEvent('end'); });
    await manager.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
    emitSpeechRecEvent('result', { isFinal: true, results: [{ transcript: 'first QA input', confidence: 0.9 }] });
    await vi.waitFor(() => expect(localVoicePendingEnqueue).toHaveBeenCalled());
    await vi.waitFor(() => expect(speechRecStart.mock.calls.length).toBeGreaterThan(1));
    expect(manager.getSnapshot().mode).toBe('listening');
    await stop();
    expect(manager.getSnapshot().status).toBe('disconnected');
  });

  it('surfaces the canonical local runtime failure after capture stop', async () => {
    await manager.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
    setRecorderUri(null);
    await expect(stop()).rejects.toThrow('voice_qa_media_stop_failed:recording_uri_missing');
    const snapshot = manager.getSnapshot();
    expect(snapshot.status).toBe('disconnected');
    expect(snapshot.errorMessage || snapshot.errorCode).toBe('recording_uri_missing');
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
  });

});
