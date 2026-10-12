import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const ValueRefV1Schema = lazyZodSchema(() => z.discriminatedUnion('t', [
  z.object({ t: z.literal('literal'), v: z.string() }).strict(),
  z.object({ t: z.literal('savedSecret'), secretId: z.string().min(1) }).strict(),
  z.object({ t: z.literal('sessionAttested'), field: z.enum(['externalPrincipalId', 'sourceMessageId', 'sessionId']) }).strict(),
]));

export type ValueRefV1 = z.infer<typeof ValueRefV1Schema>;

/** Session facts require the runtime's admitted session context. */
export function resolveValueRefPlaintextV1(ref: ValueRefV1, resolveSecret: (secretId: string) => string | null): string | null {
  if (ref.t === 'literal') return ref.v;
  if (ref.t === 'savedSecret') return resolveSecret(ref.secretId);
  return null;
}

export function listValueRefSecretIdsV1(ref: ValueRefV1): readonly string[] {
  return ref.t === 'savedSecret' ? [ref.secretId] : [];
}
