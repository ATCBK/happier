import { createVoicePlaybackController, type VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { streamKokoroWavSentences } from '@/voice/kokoro/runtime/synthesizeKokoroWav';
import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';

export async function speakKokoroText(opts: {
  text: string;
  assetSetId?: string | null;
  voiceId: string | null;
  speed: number;
  timeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  onPlaybackStarted?: () => void;
}): Promise<void> {
  if (!isKokoroRuntimeSupported()) {
    throw new Error('kokoro_runtime_unsupported');
  }

  const controller = new AbortController();
  const playback = createVoicePlaybackController();
  const registerPlaybackOnly = playback.registerStopper.captureAttempt?.() ?? playback.registerStopper;
  let clearStopper = () => {};
  let playbackStarted = false;
  const notifyPlaybackStarted = () => {
    if (playbackStarted) return;
    playbackStarted = true;
    opts.onPlaybackStarted?.();
  };

  try {
    clearStopper = opts.registerPlaybackStopper(() => {
      try {
        controller.abort();
      } catch {
        // ignore
      }
      playback.interrupt();
    });

    for await (const chunk of streamKokoroWavSentences({
      text: opts.text,
      assetSetId: typeof opts.assetSetId === 'string' ? opts.assetSetId : null,
      voiceId: opts.voiceId,
      speed: opts.speed,
      timeoutMs: opts.timeoutMs,
      signal: controller.signal,
    })) {
      await playAudioBytesWithStopper({
        bytes: chunk.wavBytes,
        format: 'wav',
        registerPlaybackStopper: registerPlaybackOnly,
        onPlaybackStarted: notifyPlaybackStarted,
      });
    }
  } finally {
    clearStopper();
  }
}
