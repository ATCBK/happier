import { z } from 'zod/mini';

const ModelSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pinned'), id: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)) }),
  z.strictObject({ kind: z.literal('moving_alias'), id: z.literal('gpt-realtime') }),
]);

const LegacyConnectedServiceProfileBindingSchema = z.strictObject({
  source: z.literal('connected'),
  selection: z.literal('profile'),
  profileId: z.string().check(z.trim(), z.minLength(1)),
});

const LegacyConnectedServiceGroupBindingSchema = z.strictObject({
  source: z.literal('connected'),
  selection: z.literal('group'),
  groupId: z.string().check(z.trim(), z.minLength(1)),
});

const LegacyConnectedServiceBindingSchema = z.discriminatedUnion('selection', [
  LegacyConnectedServiceProfileBindingSchema,
  LegacyConnectedServiceGroupBindingSchema,
]);

const LegacyOpenAiRealtimeAuthenticationSourceV1Schema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('voice_saved_secret') }),
  z.strictObject({
    source: z.literal('connected_service_api_key'),
    binding: z.optional(LegacyConnectedServiceBindingSchema),
  }),
  z.strictObject({
    source: z.literal('connected_service_oauth'),
    binding: z.optional(LegacyConnectedServiceBindingSchema),
  }),
]);

/**
 * Input transcription is off unless the session configures it, and without it
 * every committed user item keeps `transcript: null` forever. The stored
 * setting stays an optional override; an empty selection resolves to this
 * realtime-oriented default so the user side of the conversation is always
 * transcribed.
 */
export const OPENAI_REALTIME_DEFAULT_INPUT_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

export const OPENAI_REALTIME_DEFAULT_SETTINGS = Object.freeze({
  model: Object.freeze({ kind: 'pinned' as const, id: 'gpt-realtime-2.1' }),
  voice: 'marin',
  instructions: '',
  turnDetection: 'server_vad' as const,
  inputTranscriptionModel: '',
});

const OpenAiRealtimeSettingsV1CanonicalSchema = z.strictObject({
  model: z._default(ModelSelectionSchema, OPENAI_REALTIME_DEFAULT_SETTINGS.model),
  voice: z._default(z.string().check(z.trim(), z.minLength(1), z.maxLength(128)), OPENAI_REALTIME_DEFAULT_SETTINGS.voice),
  instructions: z._default(z.string().check(z.trim(), z.maxLength(10_000)), ''),
  turnDetection: z._default(z.enum(['server_vad', 'semantic_vad', 'manual']), 'server_vad'),
  inputTranscriptionModel: z._default(z.string().check(z.trim(), z.maxLength(128)), ''),
});

/**
 * Read-only compatibility contraction for settings written before qualified
 * Account Settings credential-source ownership. Authentication selection and
 * any predecessor-local binding are accepted only at ingress, then removed;
 * the runtime sees no provider-local credential authority.
 */
export const OpenAiRealtimeSettingsV1Schema = (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new z.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(z.transform((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Readonly<Record<string, unknown>>;
  const authentication = record.authentication;
  if (authentication !== undefined
    && !LegacyOpenAiRealtimeAuthenticationSourceV1Schema.safeParse(authentication).success) return value;
  const { authentication: _legacyAuthentication, ...current } = record;
  return {
    ...current,
    ...(current.instructions === null ? { instructions: '' } : {}),
    ...(current.inputTranscriptionModel === null ? { inputTranscriptionModel: '' } : {}),
  };
}), OpenAiRealtimeSettingsV1CanonicalSchema);

export type OpenAiRealtimeSettingsV1 = z.infer<typeof OpenAiRealtimeSettingsV1Schema>;
