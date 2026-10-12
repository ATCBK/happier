import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import type { UsageQuery } from '../inputs/usageQuery.js';
import { ConnectedServiceQuotaGetResultV1Schema, type ConnectedServiceQuotaGetResultV1 } from '../connect/providerAccountUsageHistorySchemasV1.js';
import { projectProviderAccountSubscriptionMonetaryFacts } from '../connect/accountSubscription.js';
import { sameQualifiedConnectedAccountRef } from '../connect/qualifiedConnectedAccountPersistence.js';
import { deriveProviderAccountUsageHeadroom, hasProviderAccountUsageWitnessedReset, resolveProviderAccountUsagePaceWindow } from '../connect/deriveProviderAccountUsagePace.js';
import { isConnectedServiceQuotaObservationFresh } from '../connect/quotaObservationTime.js';
import type { UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import type { UsageHowYouWork } from './resolveUsageHowYouWork.js';
import { resolveUsageBucketBounds, resolveUsageCalendarDateStart } from './usageCalendar.js';
import { resolveUsageCostBasis, type UsageCostBasis } from './usageCostFacts.js';

const InsufficientSchema = lazyZodSchema(() => z.object({ status: z.literal('insufficient_basis'), reason: z.string().min(1) }).strict());
const NonNegative = lazyZodSchema(() => z.number().finite().nonnegative());
const PriceMultipleSchema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('available'), multiple: NonNegative,
    priceKind: z.enum(['entered', 'list', 'paid']), priceAmount: NonNegative, currency: z.literal('USD'),
    priceAsOfMs: z.number().int().nonnegative(), priceSource: z.string().min(1),
    period: z.object({ startAtMs: z.number().int().nonnegative(), endAtMs: z.number().int().nonnegative() }).strict(),
    method: z.literal('observed_api_equivalent_divided_by_period_price') }).strict(),
  InsufficientSchema,
]));
const AccountValueSchema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('available'), kind: z.literal('api_equivalent'), amountUsd: NonNegative, currency: z.literal('USD'),
    period: z.object({ startMs: z.number().int().nonnegative().optional(), endMs: z.number().int().nonnegative().optional() }).strict(),
    coverage: z.enum(['complete', 'partial']), pricedContributionCount: z.number().int().positive(),
    unpricedContributionCount: z.number().int().nonnegative(), unknownAccountContributionCount: z.number().int().nonnegative(),
    pricingSources: z.array(z.string().min(1)), priceMultiple: PriceMultipleSchema }).strict(),
  InsufficientSchema,
]));
const WindowSchema = lazyZodSchema(() => z.object({ meterId: z.string().min(1), label: z.string().min(1), asOfMs: z.number().int().nonnegative() }).strict());
const WeatherSchema = lazyZodSchema(() => z.union([
  WindowSchema.safeExtend({ status: z.literal('available'), outlook: z.enum(['within_even_pace', 'ahead_of_even_pace']),
    projectedUsedFraction: NonNegative, sampleCount: z.number().int().positive(), resetAtMs: z.number().int().nonnegative(),
    method: z.literal('witnessed_linear_pace'), coverage: z.literal('observed_samples'), qualification: z.enum(['confirmed', 'estimated']) }).strict(),
  WindowSchema.merge(InsufficientSchema).strict(),
]));
const ModelHeadroomSchema = lazyZodSchema(() => z.union([
  WindowSchema.safeExtend({ status: z.literal('available'), modelId: z.string().min(1), remainingFraction: z.number().finite().min(0).max(1),
    resetAtMs: z.number().int().nonnegative(), method: z.literal('model_specific_quota_meter'), coverage: z.literal('current_meter'), qualification: z.enum(['confirmed', 'estimated']) }).strict(),
  WindowSchema.merge(InsufficientSchema).safeExtend({ modelId: z.string().min(1).nullable() }).strict(),
]));
const PricePerResetSchema = lazyZodSchema(() => z.union([
  WindowSchema.safeExtend({ status: z.literal('available'), amount: NonNegative, currency: z.string().regex(/^[A-Z]{3}$/),
    priceKind: z.enum(['entered', 'list', 'paid']), priceAmount: NonNegative, priceAsOfMs: z.number().int().nonnegative(),
    priceSource: z.string().min(1), period: z.object({ startAtMs: z.number().int().nonnegative(), endAtMs: z.number().int().nonnegative() }).strict(),
    recordedResetCount: z.number().int().positive(), coverage: z.literal('recorded_subset'),
    method: z.literal('period_price_divided_by_recorded_resets') }).strict(),
  WindowSchema.merge(InsufficientSchema).strict(),
]));
const RecordedWeekSchema = lazyZodSchema(() => z.union([
  z.object({ status: z.literal('available'), startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative(),
    timeZoneOffsetMinutes: z.number().int(), recordedActiveDays: z.number().int().min(0).max(7), recordedEvents: z.number().int().nonnegative(),
    observedBusyMs: NonNegative.nullable(), observedWaitMs: NonNegative.nullable(), asOfMs: z.number().int().nonnegative().nullable(),
    coverage: z.enum(['complete_recorded_history', 'partial']), accountingCoverage: z.enum(['complete', 'partial']),
    intervalCoverage: z.enum(['complete_for_supplied_facts', 'partial', 'unknown']), method: z.literal('recorded_calendar_week'), humanPresence: z.literal('unknown') }).strict(),
  InsufficientSchema,
]));

/** Read-only facts on the existing Usage result. Every envelope is closed; no input or authority is added. */
export const UsagePlanInsightsSchema = lazyZodSchema(() => z.object({
  accounts: z.array(z.object({ source: ConnectedServiceQuotaGetResultV1Schema.shape.source,
    value: AccountValueSchema, weather: z.array(WeatherSchema), pricePerReset: z.array(PricePerResetSchema), modelHeadroom: z.array(ModelHeadroomSchema) }).strict()),
  recordedWeek: RecordedWeekSchema,
}).strict());
export type UsagePlanInsights = z.infer<typeof UsagePlanInsightsSchema>;

function accountValue(read: ConnectedServiceQuotaGetResultV1, input: Parameters<typeof projectUsagePlanInsights>[0],
  price: ReturnType<typeof projectProviderAccountSubscriptionMonetaryFacts> | null): UsagePlanInsights['accounts'][number]['value'] {
  const contributions = input.accounting?.contributions ?? [];
  const matched = contributions.filter(row => row.providerAttribution === 'known' && row.connectedAccount
    && sameQualifiedConnectedAccountRef(row.connectedAccount, read.source.ref));
  if (matched.length === 0) return { status: 'insufficient_basis', reason: 'account_attribution_unavailable' };
  const unknownAccountContributionCount = contributions.filter(row => row.providerAttribution !== 'known'
    || !row.connectedAccount && row.providerSource !== 'provider'
      && !(row.providerSource === 'native' && row.connectedAccount === null)).length;
  const priced = matched.map(row => resolveUsageCostBasis(row.cost, 'api_equivalent'))
    .filter((basis): basis is UsageCostBasis => basis?.kind === 'api_equivalent');
  if (priced.length === 0) return { status: 'insufficient_basis', reason: 'account_usage_unpriced' };
  const amountUsd = priced.reduce((sum, basis) => sum + basis.amountUsd, 0);
  const selectedPrice = price?.entered ?? price?.paid ?? price?.list;
  const { startMs, endMs } = 'relative' in input.query.period
    ? input.accounting?.coverage?.range ?? {} : input.query.period;
  const priceMultiple: z.infer<typeof PriceMultipleSchema> = !selectedPrice
    ? { status: 'insufficient_basis', reason: 'period_price_unavailable' }
    : selectedPrice.currency !== 'USD' ? { status: 'insufficient_basis', reason: 'currency_mismatch' }
      : startMs === undefined || endMs === undefined || startMs < selectedPrice.period.startAtMs || endMs > selectedPrice.period.endAtMs
        ? { status: 'insufficient_basis', reason: 'period_mismatch' }
        : selectedPrice.amount === 0 ? { status: 'insufficient_basis', reason: 'zero_price' }
          : { status: 'available', multiple: amountUsd / selectedPrice.amount, priceKind: selectedPrice.kind,
            priceAmount: selectedPrice.amount, currency: 'USD', priceAsOfMs: selectedPrice.asOfMs,
            priceSource: `${selectedPrice.source.kind}:${selectedPrice.source.id}:${selectedPrice.source.version}`,
            period: selectedPrice.period, method: 'observed_api_equivalent_divided_by_period_price' };
  const unpricedContributionCount = matched.length - priced.length;
  return { status: 'available', kind: 'api_equivalent', amountUsd, currency: 'USD', period: { startMs, endMs },
    coverage: input.accounting?.coverage?.status === 'complete' && input.accounting.coverage.range.complete
      && unknownAccountContributionCount === 0 && unpricedContributionCount === 0 ? 'complete' : 'partial',
    pricedContributionCount: priced.length, unpricedContributionCount, unknownAccountContributionCount,
    pricingSources: [...new Set(priced.map(basis => basis.source))].sort(), priceMultiple };
}

function accountInsights(read: ConnectedServiceQuotaGetResultV1, input: Parameters<typeof projectUsagePlanInsights>[0]): UsagePlanInsights['accounts'][number] {
  const { nowMs } = input;
  const current = read.current;
  const fresh = current && nowMs !== undefined && current.state === 'loaded_data'
    && isConnectedServiceQuotaObservationFresh({ observedAtMs: current.observedAtMs, nowMs, maxAgeMs: current.staleAfterMs });
  const price = nowMs === undefined ? null : projectProviderAccountSubscriptionMonetaryFacts({ subscription: current?.subscription,
    nowMs, tier: current?.planLabel });
  const selectedPrice = price?.entered ?? price?.paid ?? price?.list;
  const weather: UsagePlanInsights['accounts'][number]['weather'] = [];
  const modelHeadroom: UsagePlanInsights['accounts'][number]['modelHeadroom'] = [];
  const pricePerReset: UsagePlanInsights['accounts'][number]['pricePerReset'] = [];
  const observations = [...(read.history?.entries.map(entry => entry.snapshot) ?? []), ...(current ? [current] : [])]
    .filter(snapshot => snapshot.state === 'loaded_data' && snapshot.recordId === current?.recordId)
    .sort((left, right) => left.observedAtMs - right.observedAtMs);
  for (const meter of current?.meters ?? []) {
    const base = { meterId: meter.meterId, label: meter.label, asOfMs: current!.observedAtMs };
    const pace = read.pace.find(entry => entry.meterId === meter.meterId)?.value;
    const window = resolveProviderAccountUsagePaceWindow(current!, meter.meterId);
    const validPace = fresh && pace?.status === 'available' && window && window.resetAtMs === pace.window.resetAtMs
      && window.windowStartAtMs === pace.window.windowStartAtMs && nowMs! < window.resetAtMs;
    weather.push(validPace ? { ...base, status: 'available', outlook: pace.projectedResetUtilizationFraction > 1 ? 'ahead_of_even_pace' : 'within_even_pace',
      projectedUsedFraction: pace.projectedResetUtilizationFraction, sampleCount: pace.sampleCount, resetAtMs: window.resetAtMs,
      method: 'witnessed_linear_pace', coverage: 'observed_samples', qualification: pace.qualification }
      : { ...base, status: 'insufficient_basis', reason: !fresh ? 'stale' : pace?.status === 'unavailable' ? pace.reason : 'unknown_window' });
    const headroom = nowMs === undefined ? null : deriveProviderAccountUsageHeadroom({ snapshot: current!, meterId: meter.meterId, nowMs });
    modelHeadroom.push(!meter.modelId ? { ...base, modelId: null, status: 'insufficient_basis', reason: 'model_support_unavailable' }
      : headroom?.status === 'available' ? { ...base, modelId: meter.modelId, status: 'available', remainingFraction: headroom.remainingFraction,
        resetAtMs: headroom.window.resetAtMs, method: 'model_specific_quota_meter', coverage: 'current_meter', qualification: headroom.qualification }
        : { ...base, modelId: meter.modelId, status: 'insufficient_basis', reason: headroom?.reason ?? 'unknown_observation_time' });
    const resets = new Set<number>();
    if (selectedPrice && fresh && window) for (let index = 1; index < observations.length; index++) {
      const previous = observations[index - 1]!;
      const next = observations[index]!;
      const ended = resolveProviderAccountUsagePaceWindow(previous, meter.meterId);
      // Count only the adjacent actual cycles witnessed by B, not timestamp churn or inferred gap cycles.
      if (!ended || ended.windowStartAtMs < selectedPrice.period.startAtMs
        || ended.resetAtMs > Math.min(nowMs!, selectedPrice.period.endAtMs)
        || !hasProviderAccountUsageWitnessedReset({ previous, current: next, meterId: meter.meterId, nowMs: next.observedAtMs })) continue;
      resets.add(ended.resetAtMs);
    }
    pricePerReset.push(selectedPrice && fresh && resets.size > 0 ? { ...base, status: 'available', amount: selectedPrice.amount / resets.size,
      currency: selectedPrice.currency, priceKind: selectedPrice.kind, priceAmount: selectedPrice.amount, priceAsOfMs: selectedPrice.asOfMs,
      priceSource: `${selectedPrice.source.kind}:${selectedPrice.source.id}:${selectedPrice.source.version}`,
      period: selectedPrice.period, recordedResetCount: resets.size, coverage: 'recorded_subset', method: 'period_price_divided_by_recorded_resets' }
      : { ...base, status: 'insufficient_basis', reason: !fresh ? 'stale' : !selectedPrice ? 'period_price_unavailable' : 'recorded_resets_unavailable' });
  }
  return { source: read.source, value: accountValue(read, input, price), weather, modelHeadroom, pricePerReset };
}

function recordedWeek(input: Parameters<typeof projectUsagePlanInsights>[0]): UsagePlanInsights['recordedWeek'] {
  const { startMs, endMs } = input.query.period;
  const week = startMs === undefined ? null : resolveUsageBucketBounds('week', startMs, input.query.timeZoneOffsetMinutes);
  if (!week || startMs !== week.bucketStartMs || endMs !== week.bucketEndMs) return { status: 'insufficient_basis', reason: 'whole_calendar_week_required' };
  if (input.nowMs === undefined || endMs > input.nowMs) return { status: 'insufficient_basis', reason: 'week_not_ended' };
  const days = input.accounting?.activity?.calendarDays;
  if (!days) return { status: 'insufficient_basis', reason: 'recorded_activity_unavailable' };
  const recorded = new Map<string, number>();
  for (const day of days) {
    const instant = resolveUsageCalendarDateStart(day.date, input.query.timeZoneOffsetMinutes);
    if (instant >= startMs && instant < endMs) recorded.set(day.date, day.eventCount);
  }
  const intervals = input.howYouWork?.intervals;
  const complete = input.accounting?.coverage?.range.complete === true && input.accounting.coverage.status === 'complete';
  return { status: 'available', startMs, endMs, timeZoneOffsetMinutes: input.query.timeZoneOffsetMinutes,
    recordedActiveDays: [...recorded.values()].filter(count => count > 0).length, recordedEvents: [...recorded.values()].reduce((sum, count) => sum + count, 0),
    observedBusyMs: intervals?.elapsedBusyMs ?? null, observedWaitMs: intervals?.elapsedWaitMs ?? null,
    asOfMs: input.accountingAsOfMs ?? null,
    coverage: complete && input.howYouWork?.detailStatus === 'available' && intervals?.coverage === 'complete_for_supplied_facts' ? 'complete_recorded_history' : 'partial',
    accountingCoverage: complete ? 'complete' : 'partial',
    intervalCoverage: input.howYouWork?.detailStatus === 'unknown' || !intervals ? 'unknown'
      : input.howYouWork.detailStatus === 'partial' ? 'partial' : intervals.coverage,
    method: 'recorded_calendar_week', humanPresence: 'unknown' };
}

/** Existing A/B/H composition only: no query, cache, inferred account link or model chooser. */
export function projectUsagePlanInsights(input: Readonly<{ query: UsageQuery; nowMs?: number; quota?: readonly ConnectedServiceQuotaGetResultV1[];
  accounting?: UsageAnalyticsQueryResponse; accountingAsOfMs?: number; howYouWork?: UsageHowYouWork }>): UsagePlanInsights {
  return UsagePlanInsightsSchema.parse({ accounts: (input.quota ?? []).map(read => accountInsights(read, input)), recordedWeek: recordedWeek(input) });
}
