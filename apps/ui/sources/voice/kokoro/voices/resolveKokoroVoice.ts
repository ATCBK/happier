/**
 * Voice ids are stored in one synced setting shared by every device, but web (kokoro-js) and
 * native (Sherpa model packs) ship different voice catalogs. Each platform resolves the stored id
 * against its own catalog at speak time and falls back to its own default.
 */

/** kokoro-js default voice (Kokoro-82M-v1.0); also mirrored by public/vendor/kokoro/kokoroTtsWorker.js. */
export const KOKORO_WEB_DEFAULT_VOICE_ID = 'af_heart';

export function resolveKokoroWebVoiceId(voiceId: string | null | undefined, catalogVoiceIds: Iterable<string>): string {
  const requested = typeof voiceId === 'string' ? voiceId.trim() : '';
  if (!requested) return KOKORO_WEB_DEFAULT_VOICE_ID;
  for (const id of catalogVoiceIds) {
    if (id === requested) return requested;
  }
  return KOKORO_WEB_DEFAULT_VOICE_ID;
}

type ManifestVoiceCatalog = Readonly<{
  voices?: ReadonlyArray<Readonly<{ id: string; sid?: number }>> | null;
  defaultVoiceId?: string | null;
}>;

export type ResolvedKokoroNativeVoice = Readonly<{ voiceId: string; sid: number }>;

/**
 * Resolves the voice for an installed native model pack that publishes a voice catalog. Returns
 * null only when the manifest has no usable catalog (legacy packs), in which case the caller uses
 * the built-in sherpa speaker mapping.
 */
export function resolveKokoroNativeVoice(
  manifest: ManifestVoiceCatalog | null | undefined,
  voiceId: string | null | undefined,
): ResolvedKokoroNativeVoice | null {
  const catalog = (manifest?.voices ?? []).filter(
    (voice): voice is Readonly<{ id: string; sid: number }> => typeof voice?.sid === 'number',
  );
  if (catalog.length === 0) return null;

  const requested = typeof voiceId === 'string' ? voiceId.trim() : '';
  const match =
    catalog.find((voice) => voice.id === requested)
    ?? catalog.find((voice) => voice.id === manifest?.defaultVoiceId)
    ?? catalog[0]!;
  return { voiceId: match.id, sid: match.sid };
}
