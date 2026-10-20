import { Platform } from 'react-native';

import {
  VoiceLocalSttProviderSchema,
  VoiceLocalSttSchema,
  type VoiceLocalSttProvider,
} from '@/sync/domains/settings/voiceLocalSttSettings';
import { normalizeTurnEndpointPolicy, type TurnEndpointPolicy } from '@/voice/input/TurnEndpointDetector';

export function resolveLocalVoiceAdapterSettings(settings: any): {
  adapterId: 'local_direct' | 'local_conversation';
  config: any;
} {
  const voice = settings?.voice ?? null;
  const providerId = voice?.providerId;
  if (providerId === 'local_direct') {
    return { adapterId: 'local_direct', config: voice?.adapters?.local_direct ?? {} };
  }
  if (providerId === 'local_conversation') {
    return { adapterId: 'local_conversation', config: voice?.adapters?.local_conversation ?? {} };
  }
  return {
    adapterId: 'local_conversation',
    config: voice?.adapters?.local_conversation ?? voice?.adapters?.local_direct ?? {},
  };
}

/**
 * The STT provider stored in (account-synced) settings. Legacy shapes and the default provider are
 * resolved by the settings schema so there is a single default.
 */
export function resolveConfiguredLocalSttProvider(stt: unknown): VoiceLocalSttProvider {
  const explicit = VoiceLocalSttProviderSchema.safeParse((stt as { provider?: unknown } | null | undefined)?.provider);
  if (explicit.success) return explicit.data;
  // No explicit provider: let the schema's legacy migration and default decide.
  const parsed = VoiceLocalSttSchema.safeParse(stt ?? {});
  return parsed.success ? parsed.data.provider : VoiceLocalSttSchema.parse({}).provider;
}

/**
 * The STT provider this client actually runs. Settings sync across devices, so a provider that only
 * exists on native (Sherpa `local_neural`) must not break web: web falls back to device speech
 * recognition (Web Speech API), which reports `device_stt_unavailable` when the browser lacks it.
 */
export function resolveEffectiveLocalSttProvider(
  configured: VoiceLocalSttProvider,
  platformOs: string = Platform.OS,
): VoiceLocalSttProvider {
  if (configured === 'local_neural' && platformOs === 'web') return 'device';
  return configured;
}

export function resolveLocalSttProvider(settings: any): VoiceLocalSttProvider {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return resolveEffectiveLocalSttProvider(resolveConfiguredLocalSttProvider(config?.stt));
}

/**
 * Hands-free needs a live recognizer that reports end-of-speech. Recorder-based providers
 * (`openai_compat`, `google_gemini`) upload a finished file, so they stay push-to-talk.
 */
export function localSttProviderSupportsHandsFree(provider: VoiceLocalSttProvider): boolean {
  return provider === 'device' || provider === 'local_neural';
}

export function isHandsFreeSttEnabled(settings: any): boolean {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return config?.handsFree?.enabled === true && localSttProviderSupportsHandsFree(resolveLocalSttProvider(settings));
}

export function resolveHandsFreeTurnEndpointPolicy(settings: any): TurnEndpointPolicy {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return normalizeTurnEndpointPolicy({
    silenceMs: config?.handsFree?.endpointing?.silenceMs ?? 450,
    minSpeechMs: config?.handsFree?.endpointing?.minSpeechMs ?? 120,
  });
}

/**
 * Android API-key restrictions need the app signing certificate SHA-1. It is an app-wide fact that
 * is configured once, in the Google Cloud TTS settings; Gemini STT reuses that value.
 */
export function resolveGoogleAndroidCertSha1(settings: any): string | null {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  const raw = config?.tts?.googleCloud?.androidCertSha1;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** Barge-in defaults to on, matching the `bargeInEnabled` settings schema default. */
export function isVoiceBargeInEnabled(settings: any): boolean {
  const { config } = resolveLocalVoiceAdapterSettings(settings);
  return config?.tts?.bargeInEnabled !== false;
}
