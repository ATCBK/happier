import { decodeBase64 } from '@/encryption/base64';
import { fetchWithTimeout } from '@/voice/runtime/fetchWithTimeout';
import { buildGoogleApiKeyRestrictionHeaders } from '@/voice/runtime/googleApiKeyHeaders';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/VoicePlaybackController';
import { playAudioBytesWithStopper } from '@/voice/output/playAudioBytesWithStopper';
import { createStoppableSpeech } from '@/voice/output/stoppableSpeech';
import { createTtsChunker } from '@/voice/output/TtsChunker';

// Google Cloud TTS rejects `input.text` above 5000 bytes. A UTF-8 code point is at most 4 bytes,
// so requests of at most 1250 characters always fit.
const GOOGLE_CLOUD_TTS_MAX_INPUT_CHARS = 5000 / 4;

function splitGoogleCloudTtsInput(input: string): string[] {
  const chunker = createTtsChunker(GOOGLE_CLOUD_TTS_MAX_INPUT_CHARS);
  return [...chunker.push(input), ...chunker.flush()];
}

/**
 * Speaks text with Google Cloud TTS. Resolves when playback finishes or is deliberately stopped
 * (including while a request is in flight); rejects only on a real failure.
 */
export async function speakGoogleCloudText(opts: {
  apiKey: string;
  androidCertSha1?: string | null;
  input: string;
  voiceName: string | null;
  languageCode: string | null;
  format: 'mp3' | 'wav';
  speakingRate: number | null;
  pitch: number | null;
  timeoutMs: number;
  registerPlaybackStopper: VoicePlaybackStopperRegistrar;
}): Promise<void> {
  const speech = createStoppableSpeech(opts.registerPlaybackStopper);
  try {
    for (const input of splitGoogleCloudTtsInput(opts.input)) {
      const bytes = await fetchGoogleCloudSpeechAudio({ ...opts, input, signal: speech.signal });
      if (speech.signal.aborted) return;
      await playAudioBytesWithStopper({
        bytes,
        format: opts.format,
        registerPlaybackStopper: speech.registerPlayback,
      });
      if (speech.signal.aborted) return;
    }
  } catch (error) {
    if (speech.signal.aborted) return;
    throw error;
  } finally {
    speech.dispose();
  }
}

async function fetchGoogleCloudSpeechAudio(opts: {
  apiKey: string;
  androidCertSha1?: string | null;
  input: string;
  voiceName: string | null;
  languageCode: string | null;
  format: 'mp3' | 'wav';
  speakingRate: number | null;
  pitch: number | null;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<ArrayBuffer> {
  const apiKey = String(opts.apiKey ?? '').trim();
  if (!apiKey) {
    throw new Error('google_cloud_tts_missing_api_key');
  }

  const audioEncoding = opts.format === 'wav' ? 'LINEAR16' : 'MP3';
  const voice: Record<string, unknown> = {};
  if (opts.languageCode) voice.languageCode = opts.languageCode;
  if (opts.voiceName) voice.name = opts.voiceName;

  const audioConfig: Record<string, unknown> = {
    audioEncoding,
  };
  if (opts.speakingRate != null) audioConfig.speakingRate = opts.speakingRate;
  if (opts.pitch != null) audioConfig.pitch = opts.pitch;

  const url = `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`;
  const init: RequestInit = {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'Content-Type': 'application/json',
      ...buildGoogleApiKeyRestrictionHeaders({ androidCertSha1: opts.androidCertSha1 ?? null }),
    },
    body: JSON.stringify({
      input: { text: opts.input },
      voice,
      audioConfig,
    }),
  };

  const res = await fetchWithTimeout(url, init, opts.timeoutMs, 'tts_timeout');
  if (!res.ok) {
    throw new Error(`google_cloud_tts_failed:${res.status}`);
  }

  const json = await res.json().catch(() => null);
  const audioContent = json && typeof (json as any).audioContent === 'string' ? (json as any).audioContent : null;
  if (!audioContent) {
    throw new Error('google_cloud_tts_missing_audio_content');
  }

  const decoded = decodeBase64(audioContent, 'base64');
  // Ensure we return a standalone ArrayBuffer (avoid SharedArrayBuffer unions leaking through Uint8Array.buffer typing).
  const bytes = new Uint8Array(decoded.byteLength);
  bytes.set(decoded);
  return bytes.buffer;
}
