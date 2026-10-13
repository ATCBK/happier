import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readLocalDirectVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import {
  getStorage, loadLocalVoiceEngineWithCompatState, registerLocalVoiceEngineHarnessHooks,
  setNextRecorderPrepareError, warmLocalVoiceEngineHarnessGraph,
} from './localVoiceEngine.testHarness';

import { toggleLocalVoiceTurnWithTracking } from './localVoiceTelemetry';

const restoreModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreModuleLoader());
let engine: Awaited<ReturnType<typeof loadLocalVoiceEngineWithCompatState>>;

describe('toggleLocalVoiceTurnWithTracking', () => {
  registerLocalVoiceEngineHarnessHooks({ resetModulesBetweenTests: false });
  beforeEach(async () => {
    const storage = await getStorage();
    const voice = storage.getState().settings.voice;
    const config = readLocalDirectVoiceSettings(voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: { ...voice,
      providerId: 'local_direct', providers: { ...voice.providers, local_direct: { schemaVersion: 1, config: {
        ...config, stt: { ...config.stt, provider: 'happier.voice.openai-compat/stt' },
        tts: { ...config.tts, autoSpeakReplies: false },
      } } },
    } } });
    engine = await loadLocalVoiceEngineWithCompatState();
  });

  it('captures statusBefore/statusAfter after awaiting the toggle', async () => {
    const tracking = { capture: vi.fn() };

    await toggleLocalVoiceTurnWithTracking({ sessionId: 's1',
      toggleLocalVoiceTurn: engine.toggleLocalVoiceTurn,
      getStatus: () => engine.getLocalVoiceState().status, tracking });

    expect(tracking.capture).toHaveBeenCalledWith('voice_local_turn_toggled', {
      sessionId: 's1',
      statusBefore: 'idle',
      statusAfter: 'recording',
    });
  });

  it('is a no-op for tracking when tracking is undefined', async () => {
    await expect(
      toggleLocalVoiceTurnWithTracking({
        sessionId: 's1',
        toggleLocalVoiceTurn: engine.toggleLocalVoiceTurn,
        getStatus: () => engine.getLocalVoiceState().status,
      }),
    ).resolves.toBeUndefined();
    expect(engine.getLocalVoiceState()).toMatchObject({ status: 'recording', sessionId: 's1' });
  });

  it('does not capture event when toggle throws', async () => {
    const capture = vi.fn();
    setNextRecorderPrepareError(new Error('toggle-failed'));
    await expect(
      toggleLocalVoiceTurnWithTracking({
        sessionId: 's1',
        toggleLocalVoiceTurn: engine.toggleLocalVoiceTurn,
        getStatus: () => engine.getLocalVoiceState().status,
        tracking: { capture },
      }),
    ).rejects.toThrow('toggle-failed');
    expect(capture).not.toHaveBeenCalled();
  });
});
