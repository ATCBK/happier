import { readLocalDirectVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { describe, expect, it, vi } from 'vitest';
import { uriToFilePath } from '@/platform/fileUri';
import { StrictSessionStoredMessageContentEnvelopeSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { RawRecordSchema } from '@happier-dev/session-core/raw';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { readMachineOnlineGraceMsFromEnv } from '@/utils/sessions/machineUtils';
import { VoiceLocalSttSchema } from '@/sync/domains/settings/voiceLocalSttSettings';
import { parseModelPackManifest } from '@happier-dev/protocol/voice/modelPacks/manifest';
import { installVoiceWebRtcBrowserBoundary } from '@/dev/testkit/harness/voiceWebRtcHarness';

import {
  audioStreamStart,
  audioStreamStop,
  emitAudioStreamEvent,
  LOCAL_VOICE_STT_PACK_ID,
  localVoiceModelPackFilesystem,
  nativeMicRequestPermissionsAsync,
  getStorage,
  loadLocalVoiceEngineWithCompatState,
  registerLocalVoiceEngineHarnessHooks,
  sherpaStreamingCreate,
  sherpaStreamingFinish,
  sherpaStreamingPushFrame,
  localVoicePendingEnqueue,
  setPlatformOs,
  readLocalVoiceMachinePrerequisites,
  setLocalVoiceHttpResponder,
} from './localVoiceEngine.testHarness';

function readPendingTranscripts(sessionId: string) {
  return localVoicePendingEnqueue.mock.calls.flatMap(([request]) => {
    if (request.sessionId !== sessionId) return [];
    const body: unknown = request.body;
    if (!body || typeof body !== 'object' || !('content' in body)) throw new Error('Expected canonical pending content');
    const envelope = StrictSessionStoredMessageContentEnvelopeSchema.parse(body.content);
    if (envelope.t !== 'plain') throw new Error('Expected this plain Account fixture');
    const record = RawRecordSchema.parse(envelope.v);
    return record.role === 'user' && record.content.type === 'text' ? [record.content.text] : [];
  });
}

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine local neural STT (streaming)', () => {
  registerLocalVoiceEngineHarnessHooks();

  it('fails unavailable web daemon capture without starting a native sherpa stream', async () => {
    setPlatformOs('web');
    const storage = await getStorage();
    const heartbeat = storage.getState().machines['machine-1'].activeAt;
    const readClock = Date.now.bind(Date);
    // The same unavailable heartbeat must come from the genuine census HTTP
    // boundary: the canonical presence owner intentionally ignores an older
    // inactive heartbeat. Expire the admitted heartbeat through the OS clock
    // using that owner's actual grace, without replacing its decision.
    setLocalVoiceHttpResponder(request => {
      if (request.path !== '/v1/machines' && request.path !== '/v1/machines/machine-1') return undefined;
      const machine = { ...createPlainMachineRowFixture({ id: 'machine-1', accountId: request.accountId ?? 'account-a' }),
        active: false, activeAt: heartbeat };
      return Response.json(request.path === '/v1/machines' ? [machine] : { machine });
    });
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          executionMachine: { mode: 'fixed', machineId: 'machine-1' },
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
              stt: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                provider: 'local_neural',
                localNeural: { assetId: LOCAL_VOICE_STT_PACK_ID, language: 'en', execution: 'auto' },
              },
              tts: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: false,
              },
            } },
          },
        },
      },
    });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    const graceMs = readMachineOnlineGraceMsFromEnv();
    vi.spyOn(Date, 'now').mockImplementation(() => readClock() + graceMs + 1);

    const beforeCapture = await readLocalVoiceMachinePrerequisites();
    await toggleLocalVoiceTurn('s-web-daemon');
    const stateAfterStart = getLocalVoiceState();
    if (stateAfterStart.status === 'recording' || stateAfterStart.status === 'listening') {
      await toggleLocalVoiceTurn('s-web-daemon');
    }

    expect(audioStreamStart).not.toHaveBeenCalled();
    expect(sherpaStreamingCreate).not.toHaveBeenCalled();
    expect(getLocalVoiceState(), JSON.stringify({ beforeCapture,
      afterCapture: await readLocalVoiceMachinePrerequisites(),
    })).toMatchObject({
      status: 'idle',
      sessionId: 's-web-daemon',
      error: 'daemon_streaming_stt_machine_unreachable',
    });
  });

  it('keeps mic permission denial visible as a failed attempt instead of entering recording', async () => {
    nativeMicRequestPermissionsAsync.mockResolvedValueOnce({ granted: false, canAskAgain: false });

    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
              stt: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                provider: 'local_neural',
                localNeural: { assetId: LOCAL_VOICE_STT_PACK_ID, language: 'en' },
              },
              tts: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: false,
              },
            } },
          },
        },
      },
    });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    await toggleLocalVoiceTurn('s1');

    expect(audioStreamStart).not.toHaveBeenCalled();
    expect(getLocalVoiceState()).toMatchObject({
      // Not a graceful idle end: the presence keeps "Microphone blocked" with Allow on screen.
      status: 'error',
      sessionId: 's1',
      error: 'mic_permission_denied',
    });
  });

  it('streams audio frames into Sherpa and sends the final transcript on stop', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
              stt: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                provider: 'local_neural',
                localNeural: { assetId: LOCAL_VOICE_STT_PACK_ID, language: 'en' },
              },
              tts: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: false,
              },
              handsFree: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).handsFree,
                enabled: false,
              },
            } },
          },
        },
      },
    });

    sherpaStreamingPushFrame.mockResolvedValue({ text: 'hello sherpa', isEndpoint: false });
    sherpaStreamingFinish.mockResolvedValue({ status: 'finalized', text: 'hello sherpa' });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status, JSON.stringify(getLocalVoiceState())).toBe('recording');
    expect(audioStreamStart).toHaveBeenCalled();
    expect(sherpaStreamingCreate).toHaveBeenCalledWith(expect.objectContaining({
      assetsDir: uriToFilePath(`${localVoiceModelPackFilesystem.root}/${LOCAL_VOICE_STT_PACK_ID}`),
    }));

    emitAudioStreamEvent('audioFrame', {
      streamId: 'audio-stream-1',
      pcm16leBase64: 'AA==',
      sampleRate: 16000,
      channels: 1,
    });

    const stopPromise = toggleLocalVoiceTurn('s1');
    await stopPromise;

    expect(readPendingTranscripts('s1')).toEqual(['hello sherpa']);
    expect(localVoicePendingEnqueue.mock.calls[0]?.[0].body).toMatchObject({ requestedAction: { v: 1, kind: 'send_now' } });
  });

  it('does not submit the latest provisional Sherpa partial when finalization fails', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
              stt: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                provider: 'local_neural',
                localNeural: { assetId: LOCAL_VOICE_STT_PACK_ID, language: 'en' },
              },
              tts: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: false,
              },
              handsFree: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).handsFree,
                enabled: false,
              },
            } },
          },
        },
      },
    });
    sherpaStreamingPushFrame.mockResolvedValueOnce({ text: 'provisional command', isEndpoint: false });
    // The reachable production case: the model pack was invalidated (or the job
    // cancelled) while the tail decode was claimed, so native reports a
    // non-finalized outcome rather than throwing. Dictation must not submit the
    // interim partial the user already saw as if it were the final transcript.
    sherpaStreamingFinish.mockResolvedValueOnce({ status: 'cancelled' });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    await toggleLocalVoiceTurn('s-finalization-failure');
    expect(getLocalVoiceState().status, JSON.stringify(getLocalVoiceState())).toBe('recording');
    emitAudioStreamEvent('audioFrame', {
      streamId: 'audio-stream-1',
      pcm16leBase64: 'AA==',
      sampleRate: 16000,
      channels: 1,
    });
    await vi.waitFor(() => {
      expect(sherpaStreamingPushFrame).toHaveBeenCalledTimes(1);
    });

    await toggleLocalVoiceTurn('s-finalization-failure');

    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    expect(getLocalVoiceState()).toMatchObject({
      status: 'idle',
      sessionId: 's-finalization-failure',
      error: 'local_neural_stt_finalization_failed',
    });
  });

  it('hands-free mode auto-sends endpointed local-neural turns and restarts listening', async () => {
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
              stt: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                provider: 'local_neural',
                localNeural: { assetId: LOCAL_VOICE_STT_PACK_ID, language: 'en' },
              },
              tts: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: false,
              },
              handsFree: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).handsFree,
                enabled: true,
              },
            } },
          },
        },
      },
    });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status, JSON.stringify(getLocalVoiceState())).toBe('recording');
    expect(audioStreamStart).toHaveBeenCalledTimes(1);

    sherpaStreamingPushFrame.mockResolvedValueOnce({ text: 'hands free sherpa', isEndpoint: true });

    emitAudioStreamEvent('audioFrame', {
      streamId: 'audio-stream-1',
      pcm16leBase64: 'AA==',
      sampleRate: 16000,
      channels: 1,
    });

    await vi.waitFor(() => {
      expect(readPendingTranscripts('s1')).toEqual(['hands free sherpa']);
    });
    await vi.waitFor(() => {
      expect(audioStreamStart).toHaveBeenCalledTimes(2);
    });
    expect(getLocalVoiceState().status, JSON.stringify(getLocalVoiceState())).toBe('recording');
  });

  it.each([false, true])('retires the retained mic before a refused endpoint turn becomes disconnected (spoken replies: %s)', async (autoSpeakReplies) => {
    const storage = await getStorage();
    const config = readLocalDirectVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: {
      ...storage.getState().settings,
      voice: {
        ...storage.getState().settings.voice,
        providerId: 'local_direct',
        providers: {
          ...storage.getState().settings.voice.providers,
          local_direct: { schemaVersion: 1, config: {
            ...config,
            stt: { ...config.stt, provider: 'local_neural',
              localNeural: { assetId: LOCAL_VOICE_STT_PACK_ID, language: 'en' } },
            tts: { ...config.tts, autoSpeakReplies, bargeInEnabled: true },
            handsFree: { ...config.handsFree, enabled: true },
          } },
        },
      },
    } });
    localVoicePendingEnqueue.mockResolvedValueOnce(Response.json({ error: 'turn_refused' }, { status: 400 }));
    const engine = await loadLocalVoiceEngineWithCompatState();
    const { getVoiceConversationRuntimeSnapshot, useVoiceConversationRuntimeStore } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { voiceCaptureAdmissionController } = await import('@/voice/runtime/input/VoiceCaptureAdmissionController');
    // The opt-in lane selects the same web mic source as Metro, while this
    // fixture still supplies only the physical browser/native SDK boundaries.
    const browser = process.env.HAPPIER_UI_TEST_VOICE_MIC_PLATFORM === 'web'
      ? installVoiceWebRtcBrowserBoundary() : null;
    if (browser) vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
    const failedTrackStates: MediaStreamTrackState[][] = [];
    const unsubscribe = useVoiceConversationRuntimeStore.subscribe(({ snapshot }) => {
      if (browser && snapshot.state === 'disconnected' && snapshot.error) {
        failedTrackStates.push(browser.micTracks.map(track => track.readyState));
      }
    });
    try {
      await engine.toggleLocalVoiceTurn('s1');
      expect(engine.getLocalVoiceState().status).toBe('recording');
      if (browser) expect(browser.micTrack.readyState).toBe('live');
      sherpaStreamingPushFrame.mockResolvedValueOnce({ text: 'explain the forecast', isEndpoint: true });
      emitAudioStreamEvent('audioFrame', {
        streamId: 'audio-stream-1', pcm16leBase64: 'AA==', sampleRate: 16000, channels: 1,
      });
      await vi.waitFor(() => expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
        state: 'disconnected', error: { reason: 'send_failed' },
      }));
      const captureStarts = audioStreamStart.mock.calls.length;
      expect(audioStreamStop).toHaveBeenCalledTimes(captureStarts);
      if (browser) expect(browser.micTracks.every(track => track.readyState === 'ended')).toBe(true);
      if (browser) {
        expect(failedTrackStates.length).toBeGreaterThan(0);
        expect(failedTrackStates.every(states => states.every(state => state === 'ended'))).toBe(true);
      }
      const dictation = voiceCaptureAdmissionController.acquire('dictation');
      if (dictation.status === 'acquired') dictation.lease.release();
      expect(dictation.status).toBe('acquired');
      expect(readPendingTranscripts('s1')).toEqual(['explain the forecast']);
      await engine.toggleLocalVoiceTurn('s1');
      expect(engine.getLocalVoiceState()).toMatchObject({ sessionId: 's1', status: 'recording', error: null });
      expect(audioStreamStart).toHaveBeenCalledTimes(captureStarts + 1);
    } finally {
      await engine.stopLocalVoiceSession();
      unsubscribe();
      browser?.restore();
    }
  }, 180_000);

  it('falls back to the default local_neural pack when assetId is missing', async () => {
    const defaultPackId = VoiceLocalSttSchema.parse({}).localNeural.assetId;
    if (!defaultPackId) throw new Error('Local neural STT requires its declared fallback pack');
    const fixtureManifest = localVoiceModelPackFilesystem.files.get(
      `${localVoiceModelPackFilesystem.root}/${LOCAL_VOICE_STT_PACK_ID}/pack.json`,
    );
    if (!fixtureManifest) throw new Error('Expected the installed STT boundary manifest');
    const defaultManifest = parseModelPackManifest({
      ...parseModelPackManifest(JSON.parse(new TextDecoder().decode(fixtureManifest))),
      packId: defaultPackId,
    });
    localVoiceModelPackFilesystem.files.set(
      `${localVoiceModelPackFilesystem.root}/${defaultPackId}/pack.json`,
      new TextEncoder().encode(JSON.stringify(defaultManifest)),
    );
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_direct',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_direct: { schemaVersion: 1, config: {
              ...readLocalDirectVoiceSettings(storage.getState().settings.voice),
              stt: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).stt,
                provider: 'local_neural',
                localNeural: { assetId: null, language: 'en' },
              },
              tts: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: false,
              },
              handsFree: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).handsFree,
                enabled: false,
              },
            } },
          },
        },
      },
    });

    sherpaStreamingPushFrame.mockResolvedValue({ text: 'hello sherpa', isEndpoint: false });
    sherpaStreamingFinish.mockResolvedValue({ status: 'finalized', text: 'hello sherpa' });

    const { toggleLocalVoiceTurn, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status, JSON.stringify(getLocalVoiceState())).toBe('recording');
    expect(sherpaStreamingCreate).toHaveBeenCalledWith(expect.objectContaining({
      assetsDir: uriToFilePath(`${localVoiceModelPackFilesystem.root}/${defaultPackId}`),
    }));
  });


});
