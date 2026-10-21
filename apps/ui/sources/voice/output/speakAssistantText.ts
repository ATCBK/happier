import { toSpeechText } from '@happier-dev/protocol/voice/speechText';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import type { VoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { speakWithLocalTtsProvider } from '@/voice/backends/tts/runtime';
import { parseLocalVoiceTtsSettings, resolveLocalVoiceAdapterSettings } from '@/voice/local/localVoiceSettings';

type AssistantSpeechParams = {
  sessionId?: string | null;
  text: string;
  settings: unknown;
  networkTimeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
  onSpeaking: () => void;
  onTtsFailed?: (error: VoiceMachineError) => void;
};

/** Complete assistant text enters the shared Markdown speech policy exactly once. */
export async function speakAssistantText(params: AssistantSpeechParams): Promise<void> {
  await speakAssistantSpeech({ ...params, text: toSpeechText(params.text) });
}

/** Protocol speak effects already contain speech text; dispatch them without parsing it again. */
export async function speakAssistantSpeech(params: AssistantSpeechParams): Promise<void> {
  const trimmed = params.text.trim();
  if (!trimmed) return;

  const { config } = resolveLocalVoiceAdapterSettings(params.settings);
  const tts = parseLocalVoiceTtsSettings(config?.tts);
  const registerPlaybackStopper =
    params.registerPlaybackStopper.captureAttempt?.() ?? params.registerPlaybackStopper;
  await speakWithLocalTtsProvider({
    sessionId: params.sessionId ?? null,
    text: trimmed,
    settings: params.settings,
    tts,
    networkTimeoutMs: params.networkTimeoutMs,
    registerPlaybackStopper,
    onSpeaking: params.onSpeaking,
    onTtsFailed: params.onTtsFailed,
  });
}
