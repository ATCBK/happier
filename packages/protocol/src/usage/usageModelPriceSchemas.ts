import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';

/** Exact price identities only; vendor/platform-specific tariffs remain distinct.
 * Haiku's API alias and snapshot name the same model:
 * https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide
 */
export function canonicalUsageModelPriceId(modelId: string | null | undefined): string | null {
  if (!modelId?.trim()) return null;
  const current = modelId.trim();
  return current === 'claude-haiku-4-5-20251001' ? 'claude-haiku-4-5' : current;
}

const rate = lazyZodSchema(() => z.number().finite().nonnegative());
export const UsageModelPriceRatesSchema = lazyZodSchema(() => z.object({
  inputUsdPerMillion: rate, outputUsdPerMillion: rate,
  cacheReadUsdPerMillion: rate.optional(), cacheWriteUsdPerMillion: rate.optional(), reasoningUsdPerMillion: rate.optional(),
}).strict());
export type UsageModelPriceRates = z.infer<typeof UsageModelPriceRatesSchema>;
export const UsageModelPriceEntrySchema = lazyZodSchema(() => UsageModelPriceRatesSchema.extend({
  provider: z.string().min(1).optional(), sourceUrl: z.string().url().optional(),
}).strict());
export const UsageModelPriceProvenanceSchema = lazyZodSchema(() => z.object({
  source: z.literal('litellm'), origin: z.enum(['bundled', 'fetched', 'cached']),
  asOfMs: z.number().int().nonnegative(), revision: z.string().min(1),
  fetchStatus: z.enum(['ready', 'disabled', 'error']), errorCode: z.string().min(1).optional(),
}).strict());
export type UsageModelPriceProvenance = z.infer<typeof UsageModelPriceProvenanceSchema>;
export const UsageModelPriceCatalogSchema = lazyZodSchema(() => z.object({
  v: z.literal(1), models: z.record(z.string().trim().min(1), UsageModelPriceEntrySchema),
  provenance: UsageModelPriceProvenanceSchema,
}).strict());
export type UsageModelPriceCatalog = z.infer<typeof UsageModelPriceCatalogSchema>;
export const UsageModelPriceOverrideSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  UsageModelPriceRatesSchema.omit({ reasoningUsdPerMillion: true }).extend({ kind: z.literal('rates') }).strict(),
  z.object({ kind: z.literal('map'), modelId: z.string().trim().min(1) }).strict(),
]));
// Zod records intentionally omit __proto__; reject it instead of acknowledging a lost setting.
export const UsageModelPriceOverridesV1Schema = lazyZodSchema(() => z.preprocess((value, context) => {
  if (value !== null && typeof value === 'object' && Object.hasOwn(value, '__proto__')) {
    context.addIssue({ code: 'custom', path: ['__proto__'], message: 'Reserved record key' });
  }
  return value;
}, z.record(z.string().trim().min(1), UsageModelPriceOverrideSchema)
  .superRefine((overrides, context) => {
    for (const id of Object.keys(overrides)) {
      const seen = new Set<string>();
      let current = id;
      while (Object.hasOwn(overrides, current)) {
        if (seen.has(current)) {
          context.addIssue({ code: 'custom', path: [id], message: 'Model price mappings must not contain a cycle' });
          break;
        }
        seen.add(current);
        const override = overrides[current]!;
        if (override.kind !== 'map') break;
        current = override.modelId;
      }
    }
  })));
export type UsageModelPriceOverridesV1 = z.infer<typeof UsageModelPriceOverridesV1Schema>;
