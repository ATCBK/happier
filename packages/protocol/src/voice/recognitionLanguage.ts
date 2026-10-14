import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';

/** Existing Dictation preference: null means the selected engine's default. */
export const VoiceDictationLanguageSchema = lazyZodSchema(() => z.pipe(z.transform((value) => typeof value === 'string' ? value.trim() || null : value), z.nullable(z.string().check(z.maxLength(64)))));

export function normalizeVoiceDictationLanguage(value: unknown): string | null {
  const parsed = VoiceDictationLanguageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
