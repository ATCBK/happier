import { z } from 'zod';

import { lazyZodSchema } from '../../lazyZodSchema.js';

function boundedString(maximumLength: number) {
  return z.string().min(1).max(maximumLength).refine((value) => value.trim() === value);
}

/** Recovery payloads belong to the named recovery owner and remain opaque here. */
export const ModelPackPromotionIntentV1Schema = lazyZodSchema(() => z.object({
  schemaVersion: z.literal(1),
  packId: z.string(),
  phase: z.enum(['swap_prepared', 'metadata_pending', 'metadata_committed', 'rollback_pending']),
  startedAtMs: z.number().int().nonnegative(),
  token: boundedString(256),
  priorInstall: z.object({
    scopeKey: boundedString(1024),
    identityKey: boundedString(1024),
  }).strict().nullable(),
  recovery: z.preprocess((value, context) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.hasOwn(value, 'value')) {
      context.addIssue({ code: 'custom', message: 'Recovery records require their own value field' });
    }
    return value;
  }, z.object({
    kind: boundedString(256),
    value: z.unknown(),
  }).strict().nullable()),
}).strict());
