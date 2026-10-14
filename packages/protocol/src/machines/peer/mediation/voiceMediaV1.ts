import { lazyZodSchema } from '../../../lazyZodSchema.js';
import { z } from 'zod/mini';

export const VOICE_MEDIA_VERSION_V1 = 1 as const;

const Sha256DigestSchema = lazyZodSchema(() => z.string().check(z.regex(/^sha256:[0-9a-f]{64}$/u)));

export const VoiceMediaApplicationKindV1Schema = lazyZodSchema(() => z.literal('speech_transcription'));
export type VoiceMediaApplicationKindV1 = z.infer<typeof VoiceMediaApplicationKindV1Schema>;

export const VoiceMediaApplicationAuthorityV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(VOICE_MEDIA_VERSION_V1),
  applicationKind: VoiceMediaApplicationKindV1Schema,
  applicationAttemptId: z.string().check(z.minLength(1), z.maxLength(256)),
  applicationAuthorityDigest: Sha256DigestSchema,
}));
export type VoiceMediaApplicationAuthorityV1 = z.infer<
  typeof VoiceMediaApplicationAuthorityV1Schema
>;
