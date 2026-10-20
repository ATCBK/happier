import { z } from 'zod/mini';

const OpenAiRealtimeSessionResponseSchema = z.looseObject({
  type: z.literal('realtime'),
  object: z.literal('realtime.session'),
  id: z.string().check(z.trim(), z.minLength(1), z.maxLength(512)),
  model: z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
});

export const OpenAiRealtimeClientAuthProviderResponseSchema = z.strictObject({
  value: z.string().check(z.trim(), z.minLength(1), z.maxLength(16_384)),
  expires_at: z.number().check(z.int(), z.positive()),
  // The provider response includes the created session. Its full evolving
  // configuration is bounded by the action's 64 KiB response limit; only the
  // stable discriminants are consumed before the session is projected away.
  session: OpenAiRealtimeSessionResponseSchema,
});
