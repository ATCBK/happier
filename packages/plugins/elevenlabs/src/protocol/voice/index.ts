import { z } from 'zod/mini';
import {
  compilePluginJsonSchema,
  isValidPluginJsonSchemaValue,
} from '@happier-dev/plugin-sdk/manifest';
import { SecretStringV1Schema } from '@happier-dev/plugin-sdk/secrets';
import {
  createVoiceRecordSchema,
  VoiceProviderContributionSchema,
  type VoiceProviderSettings,
  withVoiceSchemaField,
} from '@happier-dev/plugin-sdk/voice';
import { PLUGIN_MANIFEST } from '../../manifest.js';

export const ELEVENLABS_VOICE_CREDENTIAL_KIND = 'api_key' as const;
const ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION =
  VoiceProviderContributionSchema.parse(
    (PLUGIN_MANIFEST.contributes.voiceProviders ?? [])[0],
  );
if (
  ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION.kind !== 'conversation'
  || ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION.settings === undefined
) {
  throw new Error('invalid_elevenlabs_voice_provider_settings_declaration');
}
export const ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION: VoiceProviderSettings =
  ELEVENLABS_VOICE_PROVIDER_CONTRIBUTION.settings;

function readDefaultElevenLabsVoiceId(): string {
  const value = ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION.fields
    .find((field) => field.id === 'tts')
    ?.default;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_elevenlabs_voice_provider_default_voice_id');
  }
  const voiceId = value.voiceId;
  if (typeof voiceId !== 'string' || voiceId.length === 0) {
    throw new Error('invalid_elevenlabs_voice_provider_default_voice_id');
  }
  return voiceId;
}

export const DEFAULT_ELEVENLABS_VOICE_ID = readDefaultElevenLabsVoiceId();

/**
 * An ElevenLabs Agent id is opaque to Happier: trimmed, non-empty and bounded, exactly as this
 * plugin's own `update-agent` operation declares it. URL safety belongs to the request boundary,
 * which encodes the path placeholder — a character rule here would only refuse ids ElevenLabs
 * itself issues and fail the whole provider response as `provider_response_invalid`.
 */
export const ElevenLabsAgentIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));
export const ElevenLabsVoiceIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));
export const ElevenLabsModelIdSchema = z.string().check(z.trim(), z.minLength(1), z.maxLength(256));

const ElevenLabsUnitIntervalSchema = z.number().check(z.minimum(0), z.maximum(1));
const ElevenLabsTtsSpeedSchema = z.number().check(z.minimum(0.7), z.maximum(1.2));
// Tool parameters describe JSON Schema metadata, not a live tool argument value.
const ElevenLabsProvisionToolParametersSchema = createVoiceRecordSchema(
  z.json(),
);
// Keep the exported legacy parser's declaration independent of the SDK's Zod copy.
const ElevenLabsLegacyApiKeySchema: z.ZodMiniType<z.infer<typeof SecretStringV1Schema> | null> = z.nullable(SecretStringV1Schema);

export const ElevenLabsVoiceProviderSettingsLegacySchema = z.object({
  assistantLanguage: z._default(z.nullable(z.string()), null),
  billingMode: z._default(z.enum(['happier', 'byo']), 'happier'),
  welcome: z._default(z.object({
    enabled: z._default(z.boolean(), false),
    mode: z._default(z.enum(['immediate', 'on_first_turn']), 'immediate'),
    templateId: z._default(z.nullable(z.string()), null),
  }), { enabled: false, mode: 'immediate', templateId: null }),
  tts: z.prefault(z.object({
    voiceId: z._default(z.string(), DEFAULT_ELEVENLABS_VOICE_ID),
    modelId: z._default(z.nullable(z.string()), null),
    voiceSettings: z.prefault(z.object({
      stability: z._default(z.nullable(z.number().check(z.minimum(0), z.maximum(1))), null),
      similarityBoost: z._default(z.nullable(z.number().check(z.minimum(0), z.maximum(1))), null),
      style: z._default(z.nullable(z.number().check(z.minimum(0), z.maximum(1))), null),
      useSpeakerBoost: z._default(z.nullable(z.boolean()), null),
      speed: z._default(z.nullable(z.number().check(z.minimum(0.5), z.maximum(2))), null),
    }), {}),
  }), {}),
  byo: z._default(z.object({
    agentId: z._default(z.nullable(z.string()), null),
    apiKey: z._default(ElevenLabsLegacyApiKeySchema, null),
  }), { agentId: null, apiKey: null }),
});

export type ElevenLabsVoiceProviderSettings = Readonly<{
  billingMode: 'happier' | 'byo';
  tts: Readonly<{
    voiceId: string;
    modelId: string | null;
    voiceSettings: Readonly<{
      stability: number | null;
      similarityBoost: number | null;
      speed: number | null;
    }>;
  }>;
  agentId: string;
}>;

const validateElevenLabsVoiceProviderSettings = compilePluginJsonSchema({
  type: 'object',
  properties: {
    ...Object.fromEntries(ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION.fields.map(
      (field) => [field.id, field.schema],
    )),
  },
  required: [
    ...ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION.fields.map((field) => field.id),
  ],
  additionalProperties: false,
});

function cloneElevenLabsVoiceProviderSettings(
  value: unknown,
): ElevenLabsVoiceProviderSettings {
  return JSON.parse(JSON.stringify(value)) as ElevenLabsVoiceProviderSettings;
}

/**
 * Runtime parser compiled directly from the public manifest declaration.
 * Missing and unknown fields therefore fail identically in bundled and packed
 * activation paths.
 */
function safeParseElevenLabsVoiceProviderSettings(value: unknown):
  | Readonly<{ success: true; data: ElevenLabsVoiceProviderSettings }>
  | Readonly<{ success: false }> {
  return isValidPluginJsonSchemaValue(validateElevenLabsVoiceProviderSettings, value)
    ? Object.freeze({ success: true as const, data: cloneElevenLabsVoiceProviderSettings(value) })
    : Object.freeze({ success: false as const });
}

export const ElevenLabsVoiceProviderSettingsSchema = Object.freeze({
  safeParse: safeParseElevenLabsVoiceProviderSettings,
  parse(value: unknown): ElevenLabsVoiceProviderSettings {
    const parsed = safeParseElevenLabsVoiceProviderSettings(value);
    if (!parsed.success) throw new Error('invalid_elevenlabs_voice_provider_settings');
    return parsed.data;
  },
});

const parsedElevenLabsVoiceProviderDefaultSettings = ElevenLabsVoiceProviderSettingsSchema.safeParse({
  ...Object.fromEntries(ELEVENLABS_VOICE_PROVIDER_SETTINGS_DECLARATION.fields.map(
    (field) => [field.id, field.default],
  )),
});
if (!parsedElevenLabsVoiceProviderDefaultSettings.success) {
  throw new Error('invalid_elevenlabs_voice_provider_settings_defaults');
}
export const ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS =
  parsedElevenLabsVoiceProviderDefaultSettings.data;

export function buildElevenLabsConversationAuthAudience(params: Readonly<{
  agentId: string;
  textOnly: boolean;
}>): string {
  const agentId = ElevenLabsAgentIdSchema.parse(params.agentId);
  return `${params.textOnly ? 'signed_url' : 'conversation_token'}:${agentId}`;
}

export function parseElevenLabsConversationAuthAudience(value: string): Readonly<{
  kind: 'conversation_token' | 'signed_url';
  agentId: string;
}> {
  const match = /^(conversation_token|signed_url):(.+)$/u.exec(value);
  if (!match) throw Object.assign(new Error('invalid_parameters'), { code: 'invalid_parameters' });
  const agentId = ElevenLabsAgentIdSchema.safeParse(match[2]);
  if (!agentId.success) throw Object.assign(new Error('invalid_parameters'), { code: 'invalid_parameters' });
  return Object.freeze({ kind: match[1] as 'conversation_token' | 'signed_url', agentId: agentId.data });
}

const ElevenLabsProvisionToolBaseSchema = z.strictObject({
  name: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  description: z.string().check(z.trim(), z.minLength(1), z.maxLength(2_000)),
  parameters: z.nonoptional(z.unknown()),
});
export const ElevenLabsProvisionToolSchema = withVoiceSchemaField(
  ElevenLabsProvisionToolBaseSchema,
  'parameters',
  ElevenLabsProvisionToolParametersSchema,
);

export const ElevenLabsTtsConfigSchema = z.strictObject({
  voiceId: ElevenLabsVoiceIdSchema,
  modelId: z.nullable(ElevenLabsModelIdSchema),
  voiceSettings: z.strictObject({
    stability: z.nullable(ElevenLabsUnitIntervalSchema),
    similarityBoost: z.nullable(ElevenLabsUnitIntervalSchema),
    speed: z.nullable(ElevenLabsTtsSpeedSchema),
  }),
});

const ElevenLabsProvisionRequestBaseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('list'), tools: z.optional(z.never()) }),
  z.strictObject({
    kind: z.literal('create'),
    prompt: z.string().check(z.minLength(1), z.maxLength(100_000)),
    tools: z.array(z.unknown()).check(z.maxLength(100)),
    tts: ElevenLabsTtsConfigSchema,
  }),
  z.strictObject({
    kind: z.literal('update'),
    agentId: ElevenLabsAgentIdSchema,
    prompt: z.string().check(z.minLength(1), z.maxLength(100_000)),
    tools: z.array(z.unknown()).check(z.maxLength(100)),
    tts: ElevenLabsTtsConfigSchema,
  }),
]);
export const ElevenLabsProvisionRequestSchema = withVoiceSchemaField(
  ElevenLabsProvisionRequestBaseSchema,
  'tools',
  z.array(ElevenLabsProvisionToolSchema),
);
export type ElevenLabsProvisionRequest = ReturnType<
  typeof ElevenLabsProvisionRequestSchema.parse
>;

export const ElevenLabsProvisionResponseSchema = z.union([
  z.strictObject({ ok: z.literal(true), agents: z.array(z.strictObject({ agentId: ElevenLabsAgentIdSchema, name: z.string().check(z.minLength(1), z.maxLength(256)) })).check(z.maxLength(50)) }),
  z.strictObject({ ok: z.literal(true), agentId: ElevenLabsAgentIdSchema }),
  z.strictObject({ ok: z.literal(true), updated: z.literal(true) }),
  z.strictObject({ ok: z.literal(false), errorCode: z.enum(['invalid_parameters', 'credential_unavailable', 'request_timeout', 'cancelled', 'provider_response_invalid', 'internal_error']) }),
]);
export type ElevenLabsProvisionResponse = z.infer<typeof ElevenLabsProvisionResponseSchema>;
