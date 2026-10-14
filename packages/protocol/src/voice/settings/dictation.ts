import { z } from 'zod/mini';
import { VoiceDictationLanguageSchema } from '../recognitionLanguage.js';

import {
  VoiceLocalSttSchema,
} from './localStt.js';

export const VoiceDictationSettingsSchema = z.object({
  sttBinding: z._default(z.enum(['explicit', 'same_as_local']), 'explicit'),
  language: z._default(VoiceDictationLanguageSchema, null),
  stt: z.prefault(VoiceLocalSttSchema, { provider: 'device' }),
});

export type VoiceDictationSettings = z.infer<typeof VoiceDictationSettingsSchema>;

export const voiceDictationSettingsDefaults: VoiceDictationSettings =
  VoiceDictationSettingsSchema.parse({});

export function voiceDictationSettingsParse(input: unknown): VoiceDictationSettings {
  const defaults = VoiceDictationSettingsSchema.parse({});
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults;

  const raw = input as Record<string, unknown>;
  const sttBinding = VoiceDictationSettingsSchema.shape.sttBinding.safeParse(raw.sttBinding);
  const language = VoiceDictationLanguageSchema.safeParse(raw.language);
  const stt = VoiceLocalSttSchema.safeParse(raw.stt);

  return {
    sttBinding: sttBinding.success ? sttBinding.data : defaults.sttBinding,
    language: language.success ? language.data : defaults.language,
    stt: stt.success ? stt.data : defaults.stt,
  };
}
