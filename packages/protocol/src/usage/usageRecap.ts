import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { UsageQuerySchema } from '../inputs/usageQuery.js';
import { UsageObservationTokensSchema, UsageAnalyticsCostFactValueSchema, UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';
import { UsageQuerySourceStatusSchema } from './resolveUsagePageAggregation.js';
import { UsageHowYouWorkSchema } from './resolveUsageHowYouWork.js';
import { UsageFileResultSchema } from './usageExport.js';

export const USAGE_RECAP_STYLES = ['daybreak', 'sigil', 'editorial', 'glass', 'holo', 'skyline', 'terminal'] as const;
export const USAGE_RECAP_FORMATS = ['square', 'story', 'link-preview'] as const;
export const USAGE_RECAP_FIELDS = ['tokens', 'activeDays', 'streak', 'modelMix', 'agentMix', 'cache', 'rhythm', 'parallel', 'night', 'work', 'coach', 'highlights', 'names', 'dollars'] as const;
export const UsageRecapFieldSchema = lazyZodSchema(() => z.enum(USAGE_RECAP_FIELDS));
export type UsageRecapField = z.infer<typeof UsageRecapFieldSchema>;

/** One closed input for private preview and subsequent client image rendering. */
export const UsageRecapComposeInputSchema = lazyZodSchema(() => z.strictObject({
  query: UsageQuerySchema,
  style: z._default(z.enum(USAGE_RECAP_STYLES), 'daybreak'),
  format: z._default(z.enum(USAGE_RECAP_FORMATS), 'square'),
  selectedFields: z._default(z.array(UsageRecapFieldSchema), ['tokens', 'activeDays', 'modelMix', 'cache', 'rhythm', 'highlights']),
}));
export type UsageRecapComposeInput = z.infer<typeof UsageRecapComposeInputSchema>;

const count = lazyZodSchema(() => z.number().check(z.int(), z.nonnegative()));
const amount = lazyZodSchema(() => z.number().check(z.nonnegative()));
const mixRow = lazyZodSchema(() => z.strictObject({ tokens: amount, events: count, name: z.optional(z.string()) }));
const agentMixRow = lazyZodSchema(() => z.extend(mixRow, { agentId: z.optional(z.string().check(z.minLength(1))) }));
const highlight = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('observed_peak'), bucketStartMs: count, bucketEndMs: count, tokens: amount }),
  z.strictObject({ kind: z.literal('linked_outcomes'), count }),
]));

export const UsageRecapFactsSchema = lazyZodSchema(() => z.strictObject({
  tokens: z.optional(UsageObservationTokensSchema),
  activeDays: z.optional(count),
  streak: z.optional(z.strictObject({ longestDays: count })),
  modelMix: z.optional(z.array(mixRow)),
  agentMix: z.optional(z.array(agentMixRow)),
  cache: z.optional(z.strictObject({ readTokens: amount, writeTokens: amount })),
  rhythm: z.optional(z.strictObject({ calendarDays: UsageAnalyticsQueryResponseSchema.shape.activity._zod.def.innerType.shape.calendarDays._zod.def.innerType,
    weekdayHourBuckets: UsageAnalyticsQueryResponseSchema.shape.activity._zod.def.innerType.shape.weekdayHourBuckets._zod.def.innerType })),
  parallel: z.optional(z.strictObject({ sumAgentMs: amount, unionElapsedMs: amount, maximumConcurrency: count })),
  night: z.optional(UsageHowYouWorkSchema.shape.nightShift._zod.def.innerType),
  work: z.optional(z.strictObject({ linkedOutcomes: count, allocatedContributions: count, unallocatedContributions: count })),
  coach: z.optional(z.strictObject({ findings: z.array(z.strictObject({ detectorId: z.string().check(z.minLength(1)), evidenceCount: count })) })),
  highlights: z.optional(z.array(highlight)),
  dollars: z.optional(z.strictObject({ basis: UsageQuerySchema.shape.costBasis,
    // Current development read projection: selected money is not a sum of raw comparison facts.
    selected: z.nullable(z.strictObject({ kind: z.enum(['reported', 'estimated', 'api_equivalent', 'invoice', 'mixed']),
      currency: z.string().check(z.minLength(1)), amountUsd: amount })),
    facts: z.array(UsageAnalyticsCostFactValueSchema) })),
}));
export type UsageRecapFacts = z.infer<typeof UsageRecapFactsSchema>;

/** Privacy projection of existing coverage: no source identity, scope key or error text. */
export const UsageRecapCoverageSchema = lazyZodSchema(() => z.strictObject({
  accounting: z.nullable(z.omit(UsageAnalyticsQueryResponseSchema.shape.coverage._zod.def.innerType, { sources: true })),
  sourceCoverage: z.array(z.strictObject({ status: UsageQuerySourceStatusSchema, asOfMs: z.optional(count), eventCount: count, historyComplete: z.nullable(z.boolean()) })),
  sourceStatuses: z.array(z.strictObject({ status: UsageQuerySourceStatusSchema, asOfMs: z.optional(count) })),
  pending: z.boolean(),
  night: z.optional(z.strictObject({ detailStatus: z.enum(['available', 'partial', 'unknown']) })),
  coach: z.optional(z.strictObject({ currentness: z.enum(['current', 'stale', 'unknown']), asOfMs: z.nullable(count),
    findings: z.array(z.enum(['complete', 'partial', 'unknown'])) })),
  intervals: z.optional(z.strictObject({ method: z.literal('witnessed_intervals_v1'), status: z.enum(['complete_for_supplied_facts', 'partial']),
    detailStatus: z.enum(['available', 'partial', 'unknown']),
    unknownEndCount: count, invalidIntervalCount: count })),
}));

export const UsageRecapComposeResultSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('composed'), v: z.literal(1),
    style: z.enum(USAGE_RECAP_STYLES), format: z.enum(USAGE_RECAP_FORMATS),
    selectedFields: z.array(UsageRecapFieldSchema), unavailableFields: z.array(UsageRecapFieldSchema),
    period: z.strictObject({ startMs: count, endMs: count, timeZoneOffsetMinutes: UsageQuerySchema.shape.timeZoneOffsetMinutes }),
    asOfMs: z.nullable(count), coverage: UsageRecapCoverageSchema, facts: UsageRecapFactsSchema,
  }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['query_mismatch', 'accounting_unavailable', 'period_unavailable']) }),
]).check(z.superRefine((result, context) => {
  if (result.kind !== 'composed') return;
  for (const [field, value] of Object.entries(result.facts)) {
    if (value !== undefined && !result.selectedFields.some(selected => selected === field)) {
      context.addIssue({ code: 'custom', path: ['facts', field], message: 'Fact is outside the selected manifest' });
    }
  }
  if (!result.selectedFields.includes('names')) {
    for (const field of ['modelMix', 'agentMix'] as const) {
      result.facts[field]?.forEach((row, index) => {
        if (row.name !== undefined) context.addIssue({ code: 'custom', path: ['facts', field, index, 'name'], message: 'Names are not selected' });
      });
    }
  }
})));
export type UsageRecapComposeResult = z.infer<typeof UsageRecapComposeResultSchema>;
export type UsageRecapComposed = Extract<UsageRecapComposeResult, { kind: 'composed' }>;

/** Same file-byte boundary as data exports, with the recap's selected-field vocabulary. */
export const UsageRecapImageResultSchema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(UsageFileResultSchema, { fields: true }), {
  mediaType: z.literal('image/png'), selectedFields: z.array(UsageRecapFieldSchema),
})));
export type UsageRecapImageResult = z.infer<typeof UsageRecapImageResultSchema>;

export const UsageRecapExportResultSchema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('exported'), compose: UsageRecapComposeResultSchema, file: UsageRecapImageResultSchema }),
  z.strictObject({ kind: z.literal('unavailable'), reason: z.enum(['render_target_unavailable', 'render_failed', 'compose_unavailable']),
    compose: UsageRecapComposeResultSchema }),
]).check(z.superRefine((result, context) => {
  if (result.kind !== 'exported') return;
  if (result.compose.kind !== 'composed') {
    context.addIssue({ code: 'custom', path: ['compose'], message: 'Image requires composed facts' });
    return;
  }
  if (result.file.asOfMs !== result.compose.asOfMs
    || JSON.stringify(result.file.selectedFields) !== JSON.stringify(result.compose.selectedFields)
    || result.file.fileName !== usageRecapImageFileName(result.compose)) {
    context.addIssue({ code: 'custom', path: ['file'], message: 'Image does not match its composed manifest' });
  }
})));
export type UsageRecapExportResult = z.infer<typeof UsageRecapExportResultSchema>;

/** Nameless display name from style, format and the last covered calendar date. */
export function usageRecapImageFileName(result: UsageRecapComposed): string {
  const end = new Date(Math.max(result.period.startMs, result.period.endMs - 1)
    + (result.period.timeZoneOffsetMinutes ?? 0) * 60_000);
  const stamp = `${end.getUTCFullYear()}${String(end.getUTCMonth() + 1).padStart(2, '0')}${String(end.getUTCDate()).padStart(2, '0')}`;
  return `happier-usage-${result.style}-${result.format}-${stamp}.png`;
}
