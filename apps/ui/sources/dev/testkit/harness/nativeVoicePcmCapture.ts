import { vi } from 'vitest';

import type { HappierAudioStreamNativeEventMap, HappierAudioStreamNativeModule } from '../../../../../../packages/audio-stream-native/src/HappierAudioStreamNative.types';
import { createVoiceAudioSessionCoordinator, type VoiceAudioSessionApplyRequest, type VoiceAudioSessionApplyResult, type VoiceAudioSessionPlatformEvent } from '../../../../../../packages/audio-stream-native/src/voiceAudioSessionCoordinator';
import { createVoicePcmCapture } from '../../../../../../packages/audio-stream-native/src/voicePcmCapture';

/** Real capture/coordinator logic with only the native audio system boundary replaced. */
export function createNativeVoicePcmCaptureHarness(aecAvailable = true) {
  const listeners = new Map<keyof HappierAudioStreamNativeEventMap, Set<(event: never) => void>>();
  const emitEvent = <Name extends keyof HappierAudioStreamNativeEventMap>(name: Name, event: HappierAudioStreamNativeEventMap[Name]) => {
    for (const listener of listeners.get(name) ?? []) listener(event as never);
  };
  let sessionListener: ((event: VoiceAudioSessionPlatformEvent) => void) | null = null;
  let generation = 0;
  const apply = vi.fn(async (request: VoiceAudioSessionApplyRequest): Promise<VoiceAudioSessionApplyResult> => {
    generation = request.generation;
    return { generation, aecAvailable, aecActive: false, route: 'speaker' };
  });
  const restore = vi.fn(async () => {});
  const coordinator = createVoiceAudioSessionCoordinator({ platform: {
    apply,
    restore,
    subscribe: (listener) => { sessionListener = listener; return { remove: () => { sessionListener = null; } }; },
  } });
  const nativeModule = {
    start: vi.fn<HappierAudioStreamNativeModule['start']>(async () => {
      const event = { generation, kind: 'capabilities_changed' as const, aecAvailable, aecActive: aecAvailable };
      sessionListener?.(event);
      emitEvent('voiceAudioSessionEvent', event);
      return { streamId: 'native-stream' };
    }),
    stop: vi.fn(async () => {}),
    configureAudioSession: vi.fn<HappierAudioStreamNativeModule['configureAudioSession']>(async ({ generation: nativeGeneration }) => {
      generation = nativeGeneration;
      return { generation: nativeGeneration, aecAvailable, aecActive: aecAvailable, route: 'speaker' };
    }),
    restoreAudioSession: vi.fn(async () => {}),
    startPlayback: vi.fn<NonNullable<HappierAudioStreamNativeModule['startPlayback']>>(async ({ streamId, generation: streamGeneration }) => ({ streamId, generation: streamGeneration })),
    enqueuePlayback: vi.fn(() => ({ accepted: true, level: 0.5 })),
    clearPlayback: vi.fn(),
    stopPlayback: vi.fn(async () => {}),
    setPlaybackGain: vi.fn(),
    getPlaybackCursorMs: vi.fn(() => 325),
    addListener: <Name extends keyof HappierAudioStreamNativeEventMap>(name: Name, listener: (event: HappierAudioStreamNativeEventMap[Name]) => void) => {
      let subscribers = listeners.get(name);
      if (!subscribers) {
        subscribers = new Set();
        listeners.set(name, subscribers);
      }
      // Native SDK event registration is keyed by its published event map.
      const callback: (event: never) => void = listener;
      subscribers.add(callback);
      const registeredSubscribers = subscribers;
      return { remove: () => { registeredSubscribers.delete(callback); } };
    },
  } satisfies HappierAudioStreamNativeModule;
  // Spy on the SDK boundary in place so its generic event correlation survives.
  vi.spyOn(nativeModule, 'addListener');
  const capture = createVoicePcmCapture({ nativeModule, audioSessionCoordinator: coordinator });
  return {
    capture, coordinator, nativeModule, apply, restore,
    emitEvent,
    emitSession: (event: VoiceAudioSessionPlatformEvent) => sessionListener?.(event),
    emit: (pcm16leBase64 = 'AAE=') => emitEvent('audioFrame', { streamId: 'native-stream', pcm16leBase64, sampleRate: 16_000, channels: 1 }),
  };
}
