import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

/** Explicit native mode identities; an absent or null entry grants no policy support. */
export const PluginAgentAcpPermissionModeMappingV2Schema = lazyZodSchema(() => z.strictObject({
  default: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  'read-only': z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  'safe-yolo': z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  yolo: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
  plan: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))),
}));
