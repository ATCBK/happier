import { z } from 'zod/mini';

/** Read-only v1 migration input. Never use this schema for canonical writes. */
export const GoogleGeminiSttSettingsLegacySchema = z.object({
  apiKey: z._default(z.nullable(z.unknown()), null),
  model: z._default(z.string().check(z.trim(), z.minLength(1), z.maxLength(256)), 'gemini-2.5-flash'),
  language: z._default(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))), null),
});

export const GoogleGeminiSttSettingsSchema = z.strictObject({
  model: z._default(z.string().check(z.trim(), z.minLength(1), z.maxLength(256)), 'gemini-2.5-flash'),
  language: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => value === null ? '' : value), z._default(z.string().check(z.trim(), z.maxLength(64)), '')),
});

export type GoogleGeminiSttSettings = z.infer<typeof GoogleGeminiSttSettingsSchema>;

/** Read-only v1 migration input. Never use this schema for canonical writes. */
export const GoogleCloudTtsSettingsLegacySchema = z.object({
  apiKey: z._default(z.nullable(z.unknown()), null),
  androidCertSha1: z._default(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))), null),
  voiceName: z._default(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(256))), null),
  languageCode: z._default(z.nullable(z.string().check(z.trim(), z.minLength(1), z.maxLength(64))), null),
  format: z._default(z.enum(['mp3', 'wav']), 'mp3'),
  speakingRate: z._default(z.nullable(z.number().check(z.minimum(0.25), z.maximum(4))), null),
  pitch: z._default(z.nullable(z.number().check(z.minimum(-20), z.maximum(20))), null),
});

export const GoogleCloudTtsSettingsSchema = z.strictObject({
  voiceName: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => value === null ? '' : value), z._default(z.string().check(z.trim(), z.maxLength(256)), '')),
  languageCode: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => value === null ? '' : value), z._default(z.string().check(z.trim(), z.maxLength(64)), '')),
  format: z._default(z.enum(['mp3', 'wav']), 'mp3'),
  speakingRate: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => value === null ? 1 : value), z._default(z.number().check(z.minimum(0.25), z.maximum(4)), 1)),
  pitch: (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => value === null ? 0 : value), z._default(z.number().check(z.minimum(-20), z.maximum(20)), 0)),
});

export type GoogleCloudTtsSettings = z.infer<typeof GoogleCloudTtsSettingsSchema>;
export type GoogleGeminiSttSettingsLegacy = z.infer<typeof GoogleGeminiSttSettingsLegacySchema>;
export type GoogleCloudTtsSettingsLegacy = z.infer<typeof GoogleCloudTtsSettingsLegacySchema>;

export const GOOGLE_GEMINI_STT_SETTINGS_DEFAULTS: GoogleGeminiSttSettings = Object.freeze(
  GoogleGeminiSttSettingsSchema.parse({}),
);

export const GOOGLE_CLOUD_TTS_SETTINGS_DEFAULTS: GoogleCloudTtsSettings = Object.freeze(
  GoogleCloudTtsSettingsSchema.parse({}),
);
