import { vi } from 'vitest';
import type { HappierAudioStreamNativeModule, VoiceEncodedAudioPlaybackEvent } from '../../../../../../packages/audio-stream-native/src/HappierAudioStreamNative.types';

/** Native SDK leaves only; the real encoded-player owns identity and lifecycle. */
export function createVoiceEncodedAudioNativeBoundary() {
  const listeners = new Set<(event: VoiceEncodedAudioPlaybackEvent) => void>();
  let observedPlaybackId = '';
  const start = vi.fn<(uri: string) => Promise<void>>(async () => {});
  const stop = vi.fn(async () => {});
  const setPaused = vi.fn(async (_paused: boolean) => {});
  return {
    start, stop, setPaused,
    emit(event: Omit<VoiceEncodedAudioPlaybackEvent, 'playbackId'> & { playbackId?: string }) {
      for (const listener of listeners) listener({ ...event, playbackId: event.playbackId ?? observedPlaybackId });
    },
    nativeModule(base: HappierAudioStreamNativeModule): HappierAudioStreamNativeModule {
      return {
        ...base,
        startEncodedAudioPlayback: async ({ playbackId, uri }) => {
          observedPlaybackId = playbackId;
          await start(uri);
        },
        stopEncodedAudioPlayback: async () => { await stop(); },
        setEncodedAudioPlaybackPaused: async ({ paused }) => { await setPaused(paused); },
        addListener: (eventName, listener) => {
          if (eventName !== 'encodedAudioPlayback') return base.addListener(eventName, listener);
          // The generic SDK callback is narrowed by its selected native event name.
          const encodedListener = listener as (event: VoiceEncodedAudioPlaybackEvent) => void;
          listeners.add(encodedListener);
          return { remove: () => { listeners.delete(encodedListener); } };
        },
      };
    },
  };
}
