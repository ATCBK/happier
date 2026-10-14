import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Portable relay configuration; credentials stay in live invocation custody. */
export const RelayAccessConfigV1Schema = lazyZodSchema(() => z.discriminatedUnion('providerId', [
  z.strictObject({ providerId: z.literal('localOnly') }),
  z.strictObject({ providerId: z.literal('lan'), url: z.string().check(z.trim(), z.minLength(1)) }),
  z.strictObject({ providerId: z.literal('tailscaleServe') }),
  z.strictObject({ providerId: z.literal('tailscaleFunnel') }),
  z.strictObject({ providerId: z.literal('cloudflareNamed'), hostname: z.string().check(z.trim(), z.minLength(1)), token: z.string().check(z.trim(), z.minLength(1)) }),
]));
export type RelayAccessConfigV1 = Readonly<z.output<typeof RelayAccessConfigV1Schema>>;
export type RelayAccessProviderIdV1 = RelayAccessConfigV1['providerId'];
