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
import { setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';

const restoreModuleLoader = await warmLocalVoiceEngineHarnessGraph();
const { createDefaultVoiceQaControllerDeps } = await import('./voiceQaRuntimeDeps');
afterAll(() => restoreModuleLoader());

describe('Voice QA media controls', () => {
  let lifecycle: ReturnType<typeof createVoiceSessionLifecycleController>;
  let manager: ReturnType<typeof createVoiceSessionManager>;
  afterEach(async () => { await lifecycle?.dispose(); setVoiceSessionLifecycleController(null); });
  registerLocalVoiceEngineHarnessHooks();
  beforeEach(async () => {
    await loadLocalVoiceEngineWithCompatState();
    lifecycle = createVoiceSessionLifecycleController();
    lifecycle.setConfiguredProviderId('local_conversation');
    setVoiceSessionLifecycleController(lifecycle);
    manager = createVoiceSessionManager({ getLifecycleController: () => lifecycle });
  });

  const stop = () => createDefaultVoiceQaControllerDeps().stopMedia!('s1', manager.getSnapshot().adapterId);

  it('discards buffered capture when stopping the owning Voice session', async () => {
    localVoiceSpeechTranscription.mockResolvedValue('accepted QA input');
    await manager.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
    expect(manager.getSnapshot()).toMatchObject({ status: 'connected', mode: 'listening', sessionId: 's1' });
    await stop();
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    expect(localVoiceSpeechTranscription).not.toHaveBeenCalled();
    expect(manager.getSnapshot().status).toBe('disconnected');
  });

  it('commits one buffered local input explicitly, independently of Mute and End', async () => {
    localVoiceSpeechTranscription.mockResolvedValue('explicitly submitted input');
    await manager.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
    expect(manager.getSnapshot()).toMatchObject({ mode: 'listening', canCommitInput: true });
    await manager.setMuted('s1', true);
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    await Promise.all([manager.commitInput('s1'), manager.commitInput('s1')]);
    expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
    expect(localVoicePendingEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', body: expect.objectContaining({ content: { t: 'plain', v: expect.objectContaining({
        role: 'user', content: { type: 'text', text: 'explicitly submitted input' },
      }) } }),
    }));
    await manager.stop('s1');
    await manager.commitInput('s1');
    expect(localVoicePendingEnqueue).toHaveBeenCalledTimes(1);
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

  it('ends without transcribing even when the buffered recording has no URI', async () => {
    await manager.toggle({ serverId: localVoiceHomeId, sessionId: 's1' });
    setRecorderUri(null);
    await expect(stop()).resolves.toBeUndefined();
    const snapshot = manager.getSnapshot();
    expect(snapshot.status).toBe('disconnected');
    expect(snapshot.errorMessage || snapshot.errorCode).toBeFalsy();
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
  });

  it('does not reopen global Agent capture when media already disconnected', async () => {
    const storage = await getStorage();
    const voice = storage.getState().settings.voice;
    const config = readLocalConversationVoiceSettings(voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice:
      writeVoiceProviderSettingsConfig(voice, 'local_conversation', {
        ...config, conversationMode: 'agent',
        agent: { ...config.agent, agentSource: 'agent', agentId: 'claude', prewarmOnConnect: false },
        stt: { ...config.stt, provider: 'device' },
      }),
    } });
    speechRecStart.mockImplementation(() => { emitSpeechRecEvent('start'); emitSpeechRecEvent('audiostart'); });
    const starts = speechRecStart.mock.calls.length;
    expect(manager.getSnapshot().status).toBe('disconnected');
    await createDefaultVoiceQaControllerDeps().stopMedia!('__voice_agent__', 'local_conversation');
    expect(speechRecStart).toHaveBeenCalledTimes(starts);
    expect(manager.getSnapshot().status).toBe('disconnected');
  });

});
