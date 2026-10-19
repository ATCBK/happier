import { z } from 'zod/mini';

const SUPPORTED_LANGUAGE_HINTS = [
  'en', 'ar-EG', 'ar-SA', 'ar-AE', 'bn', 'zh', 'fr', 'de', 'hi', 'id', 'it', 'ja',
  'ko', 'pt-BR', 'pt-PT', 'ru', 'es-MX', 'es-ES', 'tr', 'vi',
] as const;

const XaiKeytermsSchema = z.array(z.string().check(z.trim(), z.minLength(1), z.maxLength(50))).check(z.maxLength(100), z.superRefine((values, context) => {
    const normalized = values.map((value) => value.toLocaleLowerCase('en-US'));
    if (new Set(normalized).size !== values.length) context.addIssue({ code: 'custom', message: 'Expected unique keyterms' });
  }));

const ModelSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pinned'), id: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)) }),
  z.strictObject({ kind: z.literal('moving_alias'), id: z.literal('grok-voice-latest') }),
]);

const VoiceSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('catalog'), id: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
  z.strictObject({ kind: z.literal('custom'), id: z.string().check(z.trim(), z.minLength(1), z.maxLength(256)) }),
]);

export const XAI_REALTIME_DEFAULT_SETTINGS = Object.freeze({
  model: Object.freeze({ kind: 'pinned' as const, id: 'grok-voice-think-fast-2.0' }),
  voice: Object.freeze({ kind: 'catalog' as const, id: 'eve' }),
  instructions: '',
  reasoningEffort: 'high' as const,
  outputSpeed: 1,
  transcription: Object.freeze({ languageHint: null, keyterms: Object.freeze([] as string[]) }),
  turnDetection: Object.freeze({
    mode: 'server_vad' as const,
    threshold: null,
    silenceDurationMs: null,
    prefixPaddingMs: null,
    idleTimeoutMs: null,
  }),
  resumptionEnabled: false,
});

function createDefaultKeyterms(): string[] {
  return [...XAI_REALTIME_DEFAULT_SETTINGS.transcription.keyterms];
}

function createDefaultTranscriptionSettings() {
  return {
    languageHint: XAI_REALTIME_DEFAULT_SETTINGS.transcription.languageHint,
    keyterms: createDefaultKeyterms(),
  };
}

export const XaiRealtimeSettingsV1Schema = z.strictObject({
  model: z._default(ModelSelectionSchema, XAI_REALTIME_DEFAULT_SETTINGS.model),
  voice: z._default(VoiceSelectionSchema, XAI_REALTIME_DEFAULT_SETTINGS.voice),
  instructions: z._default(z.nullable(z.string().check(z.trim(), z.maxLength(10_000))), ''),
  reasoningEffort: z._default(z.enum(['high', 'none']), 'high'),
  outputSpeed: z._default(z.number().check(z.minimum(0.7), z.maximum(1.5)), 1),
  transcription: z._default(z.strictObject({
    languageHint: z._default(z.nullable(z.enum(SUPPORTED_LANGUAGE_HINTS)), null),
    keyterms: z._default(XaiKeytermsSchema, createDefaultKeyterms),
  }), createDefaultTranscriptionSettings),
  turnDetection: z._default(z.strictObject({
    mode: z._default(z.literal('server_vad'), 'server_vad'),
    threshold: z._default(z.nullable(z.number().check(z.minimum(0.1), z.maximum(0.9))), null),
    silenceDurationMs: z._default(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(10_000))), null),
    prefixPaddingMs: z._default(z.nullable(z.number().check(z.int(), z.minimum(0), z.maximum(10_000))), null),
    idleTimeoutMs: z._default(z.nullable(z.number().check(z.int(), z.minimum(1), z.maximum(10 * 60_000))), null),
  }), XAI_REALTIME_DEFAULT_SETTINGS.turnDetection),
  resumptionEnabled: z._default(z.boolean(), false),
});

export type XaiRealtimeSettingsV1 = z.infer<typeof XaiRealtimeSettingsV1Schema>;
export const XAI_SUPPORTED_LANGUAGE_HINTS = SUPPORTED_LANGUAGE_HINTS;
