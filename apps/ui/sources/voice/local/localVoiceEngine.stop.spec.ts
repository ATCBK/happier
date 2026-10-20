import { readLocalConversationVoiceSettings, readLocalDirectVoiceSettings } from '@/sync/domains/settings/voiceSettings';
import { afterAll } from 'vitest';
import { warmLocalVoiceEngineHarnessGraph } from './localVoiceEngine.testHarness';
import { describe, expect, it, vi } from 'vitest';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import {
  localVoiceAgentRpc,
  emitSpeechRecEvent,
  expoSpeechSpeak,
  expoSpeechStop,
  fileDelete,
  flushMicrotasks,
  getStorage,
  loadLocalVoiceEngineWithCompatState,
  localVoicePendingEnqueue,
  localVoiceSpeechTranscription,
  localVoiceSpeechOutputBoundary,
  registerLocalVoiceEngineHarnessHooks,
  speechRecStart,
  speechRecStop,
} from './localVoiceEngine.testHarness';

const restoreHarnessModuleLoader = await warmLocalVoiceEngineHarnessGraph();
afterAll(() => restoreHarnessModuleLoader());

describe('local voice engine stop', () => {
  registerLocalVoiceEngineHarnessHooks();

  it.each(['end', 'close', 'provider', 'remount', 'account', 'dismiss'] as const)('cancels a pending Start waiting for an unanswered Stop on %s, then retries cleanup before Start', async (cancel) => {
    const storage = await getStorage();
    const local = readLocalConversationVoiceSettings(storage.getState().settings.voice);
    storage.__setState({ settings: { ...storage.getState().settings, voice: {
      ...storage.getState().settings.voice, providerId: 'local_conversation',
      providers: { ...storage.getState().settings.voice.providers,
        local_conversation: { schemaVersion: 1, config: { ...local, conversationMode: 'agent',
          agent: { ...local.agent, prewarmOnConnect: true },
          tts: { ...local.tts, autoSpeakReplies: false },
        } },
      },
    } } });
    await loadLocalVoiceEngineWithCompatState();
    const { createLocalConversationVoiceAdapter } = await import('@/voice/adapters/localConversation/localConversationAdapter');
    const { registerVoiceAdapters } = await import('@/voice/session/voiceAdapterRegistry');
    const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
    const { sessionRpcWithServerScope, localVoiceHomeId } = await import('./localVoiceEngine.testHarness');
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    let lifecycle = createVoiceSessionLifecycleController();
    lifecycle.setConfiguredProviderId('local_conversation');
    const target = { serverId: localVoiceHomeId, sessionId: 's1' };
    const responder = sessionRpcWithServerScope.getMockImplementation()!;
    let stalled = true;
    let entered!: () => void;
    const entering = new Promise<void>(resolve => { entered = resolve; });
    let release!: () => void;
    const acknowledgement = new Promise<void>(resolve => { release = resolve; });
    sessionRpcWithServerScope.mockImplementation(async request => {
      if (stalled && request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP) {
        entered();
        await acknowledgement;
      }
      return responder(request);
    });
    try {
      await lifecycle.toggle(target);
      await vi.waitFor(() => expect(localVoiceAgentRpc.readRetainedRun()?.status).toBe('running'));
      let stopSettled = false;
      const stopping = lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID).catch(() => undefined).finally(() => { stopSettled = true; });
      await entering;
      if (cancel === 'remount') {
        const retiring = new AbortController();
        const retiringAttempt = lifecycle.dispose(retiring.signal);
        lifecycle = createVoiceSessionLifecycleController({ retiringAttempt, cancelRetiringAttempt: () => retiring.abort() });
        lifecycle.setConfiguredProviderId('local_conversation');
      }
      let settled = false;
      const starting = lifecycle.toggle(target).finally(() => { settled = true; });
      expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connecting', canStop: true });
      const cancelled = cancel === 'close' ? lifecycle.dispose()
        : cancel === 'provider' ? Promise.resolve(lifecycle.setConfiguredProviderId('off'))
        : lifecycle.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
      await vi.waitFor(() => expect(settled).toBe(true));
      await vi.waitFor(() => expect(stopSettled).toBe(true));
      await Promise.all([stopping, starting, cancelled]);
      expect(lifecycle.getSnapshot()).toMatchObject({ mode: 'idle', canStop: false });
      if (cancel === 'end' || cancel === 'account' || cancel === 'dismiss') expect(lifecycle.getSnapshot()).toMatchObject({
        status: 'error', errorCode: 'service_temporarily_unavailable', errorMessage: 'voice_previous_session_stop_failed',
        errorRecoveryAction: 'retry',
      });
      expect(localVoiceAgentRpc.readRetainedRun()?.status).toBe('running');
      stalled = false;
      if (cancel === 'account' || cancel === 'dismiss') {
        const failedSessionId = lifecycle.getSnapshot().sessionId ?? null;
        if (cancel === 'account') {
          lifecycle.rearmAfterCredentialAuthorityChange();
          expect(lifecycle.getSnapshot().status).toBe('error');
          lifecycle.rearmAfterCredentialAuthorityChange({ exactSessionAccountScopeChanged: true });
        } else {
          await lifecycle.dismissFailedAttempt('another-session');
          expect(lifecycle.getSnapshot().status).toBe('error');
          await lifecycle.dismissFailedAttempt(failedSessionId);
        }
        expect(lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', mode: 'idle', canStop: false });
        expect(lifecycle.getSnapshot().errorCode).toBeUndefined();
        await lifecycle.retry(failedSessionId ?? VOICE_AGENT_GLOBAL_SESSION_ID);
        expect(lifecycle.getSnapshot().status).toBe('disconnected');
      }
      if (cancel === 'close') lifecycle = createVoiceSessionLifecycleController();
      lifecycle.setConfiguredProviderId('local_conversation');
      if (cancel === 'end') await lifecycle.retry(VOICE_AGENT_GLOBAL_SESSION_ID);
      else await lifecycle.toggle(target);
      await vi.waitFor(() => expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true }));
      const { isLocalVoiceAgentActive } = await import('./localVoiceEngine');
      await vi.waitFor(() => expect(isLocalVoiceAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true));
    } finally {
      stalled = false;
      release();
      await lifecycle.dispose();
    }
  });

  it('stops an in-progress recording turn without sending', async () => {
    const { toggleLocalVoiceTurn, getLocalVoiceState, stopLocalVoiceSession } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    expect(getLocalVoiceState().status).toBe('recording');

    await stopLocalVoiceSession();
    expect(getLocalVoiceState()).toMatchObject({
      status: 'idle',
      error: null,
    });
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    expect(localVoiceSpeechTranscription.mock.calls.length).toBe(0);
  });

  it('does not send a recorded-audio transcript that resolves after End Voice', async () => {
    const storage = await getStorage();
    let resolveTranscription!: (text: string) => void;
    localVoiceSpeechTranscription.mockImplementationOnce(() => new Promise((resolve) => {
      resolveTranscription = resolve;
    }));

    const { toggleLocalVoiceTurn, stopLocalVoiceSession } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    const stopAndTranscribe = toggleLocalVoiceTurn('s1');
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    await vi.waitFor(() => expect(localVoiceSpeechTranscription, JSON.stringify({
      snapshot: getVoiceConversationRuntimeSnapshot(),
      providerId: storage.getState().settings.voice.providerId,
    })).toHaveBeenCalledOnce());

    await stopLocalVoiceSession();
    resolveTranscription('late transcript');
    await stopAndTranscribe;

    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
  });

  it('retires recorded capture when native Unmute fails without publishing unmuted input', async () => {
    const { toggleLocalVoiceTurn, setLocalVoiceMuted, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    await toggleLocalVoiceTurn('recorded-unmute');
    expect(getLocalVoiceState().status).toBe('recording');
    await setLocalVoiceMuted('recorded-unmute', true);
    expect(getVoiceConversationRuntimeSnapshot().micMuted).toBe(true);
    localVoiceSpeechOutputBoundary.fileRecording.setMuted.mockRejectedValueOnce(new Error('file_recording_resume_failed'));
    await expect(setLocalVoiceMuted('recorded-unmute', false)).rejects.toThrow('file_recording_resume_failed');
    expect(getLocalVoiceState().status).toBe('idle');
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({ state: 'disconnected', micMuted: true });
    expect(localVoiceSpeechOutputBoundary.getAudioSessionCoordinator().getSnapshot().leaseCount).toBe(0);
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
  });

  it.each(['acknowledges', 'rejects'] as const)('ignores a retired native Unmute that %s after the same target starts again', async outcome => {
    const { toggleLocalVoiceTurn, setLocalVoiceMuted, stopLocalVoiceSession, getLocalVoiceState } = await loadLocalVoiceEngineWithCompatState();
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    await toggleLocalVoiceTurn('recorded-retry');
    await setLocalVoiceMuted('recorded-retry', true);
    let resolveResume!: () => void;
    let rejectResume!: (error: Error) => void;
    const resume = new Promise<void>((resolve, reject) => { resolveResume = resolve; rejectResume = reject; });
    localVoiceSpeechOutputBoundary.fileRecording.setMuted.mockImplementationOnce(async () => { await resume; });
    const unmuting = setLocalVoiceMuted('recorded-retry', false).catch(error => error);
    await vi.waitFor(() => expect(localVoiceSpeechOutputBoundary.fileRecording.setMuted).toHaveBeenLastCalledWith({
      recordingId: 'local-engine-recording', muted: false,
    }));
    try {
      await stopLocalVoiceSession();
      await toggleLocalVoiceTurn('recorded-retry');
      await setLocalVoiceMuted('recorded-retry', true);
      expect(getLocalVoiceState().status).toBe('recording');
      expect(localVoiceSpeechOutputBoundary.fileRecording.setMuted).toHaveBeenLastCalledWith({
        recordingId: 'local-engine-recording', muted: true,
      });
    } finally {
      if (outcome === 'rejects') rejectResume(new Error('file_recording_resume_failed'));
      else resolveResume();
    }
    await unmuting;
    expect(getLocalVoiceState().status).toBe('recording');
    expect(getVoiceConversationRuntimeSnapshot().micMuted).toBe(true);
  });

  it('still releases Local Agent execution and effect custody when finalized-recording cleanup fails during End Voice', async () => {
    const cleanupFailure = new Error('recording_delete_failed');
    const storage = await getStorage();
    storage.__setState({
      settings: {
        ...storage.getState().settings,
        voice: {
          ...storage.getState().settings.voice,
          providerId: 'local_conversation',
          providers: {
            ...storage.getState().settings.voice.providers,
            local_conversation: { schemaVersion: 1, config: {
              ...readLocalConversationVoiceSettings(storage.getState().settings.voice),
              conversationMode: 'agent',
              stt: {
                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).stt,
                baseUrl: 'http://localhost:8000',
              },
              agent: {
                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).agent,
                prewarmOnConnect: true,
              },
              tts: {
                ...readLocalConversationVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: false,
              },
            } },
          },
        },
      },
      sessions: {
        ...storage.getState().sessions,
        s1: {
          id: 's1',
          active: true,
          presence: 'online',
          modelMode: 'default',
          metadata: { flavor: 'claude' },
        },
      },
    });
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { voiceCaptureAdmissionController } = await import(
      '@/voice/runtime/input/VoiceCaptureAdmissionController'
    );
    const { voiceRuntimeLevelStore } = await import('@/voice/runtime/levels/voiceRuntimeLevelStore');
    const { getRetainedLocalVoiceEffectOutcomes } = await import(
      '@/voice/tools/localVoiceEffectOutcomeCustody'
    );
    const {
      getLocalVoiceState,
      isLocalVoiceAgentActive,
      stopLocalVoiceSession,
      toggleLocalVoiceTurn,
    } = await loadLocalVoiceEngineWithCompatState();

    await toggleLocalVoiceTurn('s1');
    await vi.waitFor(() => expect(localVoiceAgentRpc.readRetainedRun(), JSON.stringify(getVoiceConversationRuntimeSnapshot())).toMatchObject({ status: 'running', intent: 'voice_agent' }));
    await flushMicrotasks(4_000);
    expect(isLocalVoiceAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(true);
    expect(voiceRuntimeLevelStore.getSnapshot().inputSourceActive).toBe(true);
    getRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID).set('effect-1', {
      fingerprint: 'effect-fingerprint',
      outcome: Promise.resolve({ t: 'sendSessionMessage', args: {}, result: { ok: true } }),
    });

    fileDelete.mockImplementationOnce(() => { throw cleanupFailure; });
    await expect(stopLocalVoiceSession()).rejects.toBe(cleanupFailure);

    expect(fileDelete).toHaveBeenCalledOnce();
    expect(localVoiceAgentRpc.readRetainedRun()).toBeNull();
    expect(isLocalVoiceAgentActive(VOICE_AGENT_GLOBAL_SESSION_ID)).toBe(false);
    expect(getRetainedLocalVoiceEffectOutcomes(VOICE_AGENT_GLOBAL_SESSION_ID).size).toBe(0);
    expect(voiceRuntimeLevelStore.getSnapshot()).toMatchObject({
      inputLevel: 0,
      inputSourceActive: false,
    });
    const dictation = voiceCaptureAdmissionController.acquire('dictation');
    expect(dictation.status).toBe('acquired');
    if (dictation.status === 'acquired') {
      dictation.lease.release();
    }
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
      state: 'disconnected',
      micMuted: false,
      error: {
        reason: 'recording_cleanup_failed',
      },
    });
    expect(getLocalVoiceState()).toMatchObject({
      status: 'idle',
      error: 'recording_cleanup_failed',
    });
    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
  });

  it('stops device STT recording without sending', async () => {
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
                provider: 'device',
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

    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { toggleLocalVoiceTurn, stopLocalVoiceSession } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    expect(speechRecStart).toHaveBeenCalledTimes(1);

    const stopPromise = stopLocalVoiceSession();
    expect(speechRecStop).toHaveBeenCalledTimes(1);
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'ending',
      error: null,
    });
    emitSpeechRecEvent('end', {});
    await stopPromise;

    expect(localVoicePendingEnqueue).not.toHaveBeenCalled();
    expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
      controlSessionId: 's1',
      state: 'disconnected',
      error: null,
    });
  });

  it('cancels an in-flight turn while keeping the conversation connected', async () => {
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
              tts: {
                ...readLocalDirectVoiceSettings(storage.getState().settings.voice).tts,
                autoSpeakReplies: true,
                provider: 'device',
              },
            } },
          },
        },
      },
    });

    localVoiceSpeechTranscription.mockResolvedValueOnce('hello world');

    const { getVoiceConversationRuntimeSnapshot, useVoiceConversationRuntimeStore } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');
    const { abortLocalVoiceTurn, toggleLocalVoiceTurn } = await import('./localVoiceEngine');

    await toggleLocalVoiceTurn('s1');
    const stopPromise = toggleLocalVoiceTurn('s1');

    await vi.waitFor(() => {
      expect(getVoiceConversationRuntimeSnapshot(), JSON.stringify({ providerId: storage.getState().settings.voice.providerId })).toMatchObject({
        controlSessionId: 's1',
        state: 'thinking',
        error: null,
      });
    });
    // This admitted turn proves that the same real outbound boundary observed
    // by the End negatives actually receives direct-session submissions.
    await vi.waitFor(() => expect(localVoicePendingEnqueue).toHaveBeenCalledOnce());

    const observedStates: string[] = [];
    const unsubscribe = useVoiceConversationRuntimeStore.subscribe(({ snapshot }) => observedStates.push(snapshot.state));
    try {
      const abortPromise = abortLocalVoiceTurn('s1');
      expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
        controlSessionId: 's1',
        state: 'connected',
        error: null,
      });

      await abortPromise;
      await stopPromise;

      expect(getVoiceConversationRuntimeSnapshot()).toMatchObject({
        controlSessionId: 's1',
        state: 'connected',
        error: null,
      });
      expect(observedStates).not.toContain('ending');
      expect(observedStates).not.toContain('disconnected');
    } finally {
      unsubscribe();
    }
  });


});
