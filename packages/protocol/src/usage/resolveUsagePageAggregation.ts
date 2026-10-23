import { z } from 'zod/mini';
import type { UsageCoachPreferencesV1 } from '../account/settings/usageCoachPreferencesV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { getUsageQueryKey, normalizeUsageQuery, resolveUsageQueryPeriod, UsageQuerySchema, type UsageQuery } from '../inputs/usageQuery.js';
import { UsageQueryAccountingSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { UsageCostFactTotalSchema, projectUsageCostFactTotals } from './usageCostFactTotals.js';
import { allocateUsageOutcomes, summarizeUsageMergedOutcomes, UsageMergedOutcomeSummarySchema, UsageWorkProjectionSchema, type UsageWorkEvidence } from './usageOutcomeAllocation.js';
import type { ScmBranchWorkEvidence } from '../scm/branches.js';
import { resolveUsageHowYouWork, UsageHowYouWorkSchema, type UsageHowYouWorkDetailInput, type UsageSessionEvidenceCoverage } from './resolveUsageHowYouWork.js';
import type { UsageWorkIntervalsInput } from './usageWorkIntervals.js';
import { ConnectedServiceQuotaGetResultV1Schema, type ConnectedServiceQuotaGetResultV1 } from '../connect/providerAccountUsageHistorySchemasV1.js';
import { evaluateUsageCoach } from './coach/evaluateUsageCoach.js';
import { createUsageCoachDigestSuggestion } from './coach/coachDigestSuggestion.js';
import { UsageCoachEvaluationSchema } from './coach/coachFinding.js';
import { QualifiedConnectedAccountGroupRefSchema } from '../connect/qualifiedConnectedAccountProjectionsV4.js';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '../connect/connectedServicePoolSelection.js';
import { repriceUsageAnalyticsResponse } from './usageCost.js';
import type { UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { projectUsagePlanInsights, UsagePlanInsightsSchema } from './usagePlanInsights.js';
import { hasSameUsageQueryWorkEvidenceMembership } from './usageWorkEvidence.js';
import { projectUsageAgentAccountingCalendar, type UsageAgentAccountingCalendar } from './usageAgentCalendar.js';
export type { UsagePlanInsights } from './usagePlanInsights.js';

/** Source transport currentness is separate from accounting completeness. */
export const UsageQuerySourceStatusSchema = lazyZodSchema(() => z.enum([
  'available', 'stale', 'not_loaded', 'pending', 'error', 'unsupported', 'unknown', 'partial',
]));
export const UsageQuerySourceStateSchema = lazyZodSchema(() => z.strictObject({
  source: z.string().check(z.trim(), z.minLength(1)),
  status: UsageQuerySourceStatusSchema,
  asOfMs: z.optional(z.number().check(z.int(), z.nonnegative())),
  errorCode: z.optional(z.string().check(z.trim(), z.minLength(1))),
}));
export type UsageQuerySourceState = z.infer<typeof UsageQuerySourceStateSchema>;

/** Pool membership is an Account projection, separate from unique B account/window facts. */
export const UsageQueryPoolSnapshotSchema = lazyZodSchema(() => z.strictObject({
  group: QualifiedConnectedAccountGroupRefSchema,
  memberAccountIds: z.array(z.string().check(z.trim(), z.minLength(1))),
  activeAccountId: z.nullable(z.string().check(z.trim(), z.minLength(1))),
  selection: (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(UsageQuerySourceStateSchema, { source: true }), {
    machineId: z.optional(z.string().check(z.trim(), z.minLength(1))),
    value: z.optional(ConnectedServicePoolSelectionGetResponseV1Schema),
  })),
}).check(z.superRefine((pool, context) => {
  const value = pool.selection.value;
  if (value && !['available', 'stale'].includes(pool.selection.status)) {
    context.addIssue({ code: 'custom', path: ['selection'], message: 'Unavailable selector cannot disclose retained decisions' });
  }
  if (value && 'group' in value && !sameStrictJsonValue(value.group, pool.group)) {
    context.addIssue({ code: 'custom', path: ['selection'], message: 'Selector must identify its qualified pool' });
  }
})));
export type UsageQueryPoolSnapshot = z.infer<typeof UsageQueryPoolSnapshotSchema>;
export type UsagePoolSourceSnapshot = Readonly<{ query: UsageQuery; value: readonly UsageQueryPoolSnapshot[] }>;

function readBoundedAccountingPeriod(value: UsageAnalyticsQueryResponse | undefined) {
  const range = value?.coverage?.range;
  return range?.startMs !== undefined && range.endMs !== undefined
    ? { startMs: range.startMs, endMs: range.endMs } : undefined;
}

export const UsageQueryResultSliceSchema = lazyZodSchema(() => z.strictObject({
  key: z.string().check(z.minLength(1)),
  requestedQuery: UsageQuerySchema,
  shownQuery: UsageQuerySchema,
  accounting: z.optional(UsageQueryAccountingSchema),
  costFactTotals: z.optional(z.array(UsageCostFactTotalSchema)),
  quota: z.optional(z.array(ConnectedServiceQuotaGetResultV1Schema)),
  pools: z.optional(z.array(UsageQueryPoolSnapshotSchema)),
  planInsights: z.optional(UsagePlanInsightsSchema),
  comparison: z.optional(z.strictObject({ query: UsageQuerySchema, accounting: z.optional(UsageQueryAccountingSchema),
    costFactTotals: z.optional(z.array(UsageCostFactTotalSchema)),
    source: UsageQuerySourceStateSchema })),
  work: z.optional(UsageWorkProjectionSchema),
  mergedOutcomes: z.optional(UsageMergedOutcomeSummarySchema),
  howYouWork: z.optional(UsageHowYouWorkSchema),
  coach: z.optional(UsageCoachEvaluationSchema),
  sources: z.array(UsageQuerySourceStateSchema),
  pending: z.boolean(),
}).check(z.superRefine((slice, context) => {
  if (slice.key !== getUsageQueryKey(slice.requestedQuery)) {
    context.addIssue({ code: 'custom', path: ['key'], message: 'Result key must identify the requested query' });
  }
  if (!slice.requestedQuery.includeAccounting && (slice.accounting || slice.comparison || slice.costFactTotals || slice.work || slice.mergedOutcomes || slice.howYouWork || slice.coach)) {
    context.addIssue({ code: 'custom', path: ['accounting'], message: 'Quota-only demand cannot disclose accounting or Session evidence' });
  }
  // An Action snapshot names exactly what it queried. Previous-period display
  // belongs to the retained Resource consumer, never relabelled Action facts.
  if (getUsageQueryKey(slice.shownQuery) !== slice.key) {
    context.addIssue({ code: 'custom', path: ['shownQuery'], message: 'Shown facts must identify the queried slice' });
  }
  if (slice.costFactTotals && (!slice.accounting || !sameStrictJsonValue(
    slice.costFactTotals, projectUsageCostFactTotals(slice.accounting.costFacts ?? [])))) {
    context.addIssue({ code: 'custom', path: ['costFactTotals'], message: 'Money totals must preserve the exact admitted accounting and source provenance' });
  }
  if (slice.comparison?.costFactTotals && (!slice.comparison.accounting || !sameStrictJsonValue(
    slice.comparison.costFactTotals, projectUsageCostFactTotals(slice.comparison.accounting.costFacts ?? [])))) {
    context.addIssue({ code: 'custom', path: ['comparison', 'costFactTotals'], message: 'Comparison money totals must preserve their admitted accounting and source provenance' });
  }
  // Retained private evidence and its calendar can have an older read window
  // during progression. Accounting comparisons belong to the witnessed A window.
  const accountingPeriod = 'relative' in slice.shownQuery.period
    ? readBoundedAccountingPeriod(slice.accounting) ?? slice.coach?.period ?? slice.accounting?.coverage?.range
    : slice.shownQuery.period;
  if (slice.comparison) {
    const expected = resolveUsageComparisonQuery(slice.requestedQuery, accountingPeriod);
    if (!expected || getUsageQueryKey(slice.comparison.query) !== getUsageQueryKey(expected)) {
      context.addIssue({ code: 'custom', path: ['comparison', 'query'], message: 'Comparison must identify the exact preceding range' });
    }
  }
  if (slice.work && (!slice.accounting?.contributions || !sameStrictJsonValue(
    slice.work.allocations.map(row => row.contribution), slice.accounting.contributions))) {
    context.addIssue({ code: 'custom', path: ['work'], message: 'Work must conserve the exact admitted contributions' });
  }
  if (slice.quota && !slice.sources.some(source => source.source === 'quota' && ['available', 'partial', 'stale'].includes(source.status))) {
    context.addIssue({ code: 'custom', path: ['quota'], message: 'Unavailable allowance cannot disclose protected facts' });
  }
  if (slice.planInsights?.accounts.some(account => !slice.quota?.some(read => sameStrictJsonValue(read.source, account.source)))) {
    context.addIssue({ code: 'custom', path: ['planInsights', 'accounts'], message: 'Plan facts must identify an admitted qualified allowance account' });
  }
  const week = slice.planInsights?.recordedWeek;
  const witnessedPeriod = 'relative' in slice.shownQuery.period
    ? slice.coach?.period ?? accountingPeriod
    : slice.shownQuery.period;
  if (slice.mergedOutcomes && (!slice.work || witnessedPeriod?.startMs === undefined || witnessedPeriod.endMs === undefined
    || !slice.sources.some(source => source.source === 'work' && ['available', 'partial', 'stale', 'pending'].includes(source.status))
    || !sameStrictJsonValue(slice.mergedOutcomes, summarizeUsageMergedOutcomes({ work: slice.work,
      period: { startMs: witnessedPeriod.startMs, endMs: witnessedPeriod.endMs }, timeZoneOffsetMinutes: slice.shownQuery.timeZoneOffsetMinutes })))) {
    context.addIssue({ code: 'custom', path: ['mergedOutcomes'], message: 'Merged outcomes must preserve the admitted Work, period and calendar' });
  }
  if (week?.status === 'available' && (!slice.accounting?.activity
    || week.startMs !== accountingPeriod?.startMs || week.endMs !== accountingPeriod?.endMs
    || week.timeZoneOffsetMinutes !== slice.shownQuery.timeZoneOffsetMinutes)) {
    context.addIssue({ code: 'custom', path: ['planInsights', 'recordedWeek'], message: 'Recorded week must preserve admitted accounting period and calendar' });
  }
  if ((slice.work?.allocations.some(row => row.evidence.length > 0) || slice.work?.branchAllocations.some(row => row.evidence.length > 0))
    && !slice.sources.some(source => source.source === 'work' && ['available', 'partial', 'stale', 'pending'].includes(source.status))) {
    context.addIssue({ code: 'custom', path: ['work'], message: 'Unavailable Work sources cannot disclose private evidence' });
  }
  const intervals = slice.howYouWork?.intervals;
  if (intervals && (intervals.timeZoneOffsetMinutes !== slice.shownQuery.timeZoneOffsetMinutes
    || (witnessedPeriod?.startMs !== undefined && intervals.period.startMs !== witnessedPeriod.startMs)
    || (witnessedPeriod?.endMs !== undefined && intervals.period.endMs !== witnessedPeriod.endMs))) {
    context.addIssue({ code: 'custom', path: ['howYouWork'], message: 'Intervals must identify the shown period and calendar' });
  }
  if (intervals && !slice.sources.some(isUsageDetailSourceReadable)) {
    context.addIssue({ code: 'custom', path: ['howYouWork'], message: 'Unavailable detail cannot disclose private intervals' });
  }
  const agentCalendar = slice.howYouWork?.agentCalendar;
  if (agentCalendar && (agentCalendar.timeZoneOffsetMinutes !== slice.shownQuery.timeZoneOffsetMinutes
    || witnessedPeriod?.startMs !== undefined && agentCalendar.period.startMs !== witnessedPeriod.startMs
    || witnessedPeriod?.endMs !== undefined && agentCalendar.period.endMs !== witnessedPeriod.endMs)) {
    context.addIssue({ code: 'custom', path: ['howYouWork', 'agentCalendar'], message: 'Agent calendar must identify the shown period and fixed offset' });
  }
  if (slice.coach && (slice.coach.queryKey !== slice.key
    || (slice.shownQuery.period.startMs !== undefined && slice.coach.period.startMs !== slice.shownQuery.period.startMs)
    || (slice.shownQuery.period.endMs !== undefined && slice.coach.period.endMs !== slice.shownQuery.period.endMs))) {
    context.addIssue({ code: 'custom', path: ['coach'], message: 'Coach must identify the exact admitted query period' });
  }
  if (slice.coach?.findings.some(finding => finding.evidence.some(evidence => evidence.kind !== 'accounting'))
    && !slice.sources.some(isUsageDetailSourceReadable)) {
    context.addIssue({ code: 'custom', path: ['coach'], message: 'Unavailable detail cannot disclose private Coach evidence' });
  }
})));
export type UsageQueryResultSlice = z.infer<typeof UsageQueryResultSliceSchema>;

export const UsageQueryBatchResultSchema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  results: z.array(UsageQueryResultSliceSchema),
}).check(z.superRefine((batch, context) => {
  const keys = new Set<string>();
  batch.results.forEach((slice, index) => {
    if (keys.has(slice.key)) context.addIssue({ code: 'custom', path: ['results', index, 'key'], message: 'Duplicate query slice' });
    keys.add(slice.key);
  });
})));
export type UsageQueryBatchResult = z.infer<typeof UsageQueryBatchResultSchema>;

/** Compare changed members once; already reconciled children need only identity checks. */
function retainUsageMembers<T extends object>(value: T, previous: T, reconciled: readonly (keyof T)[] = []): T {
  if (value === previous) return previous;
  const keys = Object.keys(value) as Array<keyof T>;
  let result = value;
  for (const key of keys) {
    if (!reconciled.includes(key) && value[key] !== previous[key] && sameStrictJsonValue(value[key], previous[key])) {
      result = { ...result, [key]: previous[key] };
    }
  }
  return keys.length === Object.keys(previous).length && keys.every(key =>
    Object.prototype.hasOwnProperty.call(previous, key) && result[key] === previous[key]) ? previous : result;
}

// Admitted accounting is immutable. Independent quota/evidence publications
// repeatedly reconcile the same response against its already accepted result;
// do not walk the complete contribution history again for each publication.
const accountingReferenceReconciliations = new WeakMap<UsageAnalyticsQueryResponse, {
  previous: UsageAnalyticsQueryResponse; value: UsageAnalyticsQueryResponse;
}>();
const accountingSourceLocationProjections = new WeakMap<UsageAnalyticsQueryResponse, {
  locations: UsagePageAggregationInput['sourceLocations']; value: UsageAnalyticsQueryResponse;
}>();

/** Reuse semantically unchanged validated slices from the caller's same-authority prior value. */
export function retainUsageQueryResultReferences(current: UsageQueryBatchResult,
  previous: UsageQueryBatchResult | undefined, settled?: UsageQueryBatchResult): UsageQueryBatchResult {
  if (!previous || current === previous) return current;
  const prior = new Map(previous.results.map(slice => [slice.key, slice]));
  const original = new Map(settled?.results.map(slice => [slice.key, slice]));
  const retainAccounting = (value: UsageAnalyticsQueryResponse | undefined, retained: UsageAnalyticsQueryResponse | undefined) => {
    if (!value || !retained || value === retained) return value;
    const input = value;
    const known = accountingReferenceReconciliations.get(input);
    if (known && (known.previous === retained || known.value === retained)) return known.value;
    // New accounting facts do not replace unchanged tariffs. Keeping the
    // admitted catalog also lets prior/current UI projections share its model
    // dictionaries instead of retaining a full clone on every refresh.
    if (value.priceCatalog && retained.priceCatalog && value.priceCatalog !== retained.priceCatalog) {
      value = { ...value, priceCatalog: retainUsageMembers(value.priceCatalog, retained.priceCatalog) };
    }
    const reconciled = retainUsageMembers(value, retained, ['priceCatalog']);
    accountingReferenceReconciliations.set(input, { previous: retained, value: reconciled });
    return reconciled;
  };
  const results = current.results.map(slice => {
    const retained = prior.get(slice.key);
    if (!retained || slice === retained) return slice;
    // Source progress replaces the slice, not its unchanged accounting. Mounted
    // consumers key their existing price/ranking projections by these facts.
    let reconciled = slice;
    const accounting = retainAccounting(slice.accounting, retained.accounting);
    if (accounting !== slice.accounting) {
      reconciled = { ...reconciled, accounting };
    }
    if (slice.comparison?.accounting && retained.comparison?.accounting
      && getUsageQueryKey(slice.comparison.query) === getUsageQueryKey(retained.comparison.query)) {
      const accounting = retainAccounting(slice.comparison.accounting, retained.comparison.accounting);
      reconciled = { ...reconciled, comparison: retainUsageMembers({ ...slice.comparison, accounting }, retained.comparison, ['accounting']) };
    }
    // A source revision also leaves the other admitted projections unchanged.
    // Keep their references for selectors and the Resource's byte projection.
    const result = retainUsageMembers(reconciled, retained, ['accounting', ...(slice.comparison?.accounting && retained.comparison?.accounting
      && getUsageQueryKey(slice.comparison.query) === getUsageQueryKey(retained.comparison.query) ? ['comparison' as const] : [])]);
    // A source can return to its settled state after a pending revision. Only
    // a changed slice needs that original identity restored; re-reconciling an
    // unchanged current slice against the baseline would replace equal child
    // references and force its identical transport bytes to be hashed again.
    const baseline = original.get(slice.key);
    return result !== retained && baseline && sameStrictJsonValue(result, baseline) ? baseline : result;
  });
  if (results.length === previous.results.length
    && results.every((slice, index) => slice === previous.results[index])) return previous;
  if (results.every((slice, index) => slice === current.results[index])) return current;
  return { ...current, results };
}

export type UsageAccountingSourceSnapshot = Readonly<{
  query: UsageQuery;
  /** Captured once by the read planner, including failed/pending reads. */
  period?: ReturnType<typeof resolveUsageQueryPeriod>;
  value?: UsageAnalyticsQueryResponse;
  status: UsageQuerySourceState['status'];
  asOfMs?: number;
  errorCode?: string;
  /** Same-read derived value held by the existing accounting snapshot owner; never serialized. */
  priceProjection?: Readonly<{
    input: UsageAnalyticsQueryResponse;
    overrides: UsageModelPriceOverridesV1 | undefined;
    costBasis: UsageQuery['costBasis'];
    value: UsageAnalyticsQueryResponse;
  }>;
  /** Accounting-only calendar for this admitted response and numeric query basis; never serialized. */
  agentCalendarAccounting?: UsageAgentAccountingCalendar;
}>;

/** Reconcile one retained accounting snapshot at its existing owner, before independent source publications. */
export function projectUsageAccountingSnapshotPrices(snapshot: UsageAccountingSourceSnapshot,
  overrides: UsageModelPriceOverridesV1 | undefined,
  siblings?: Iterable<UsageAccountingSourceSnapshot>): UsageAccountingSourceSnapshot {
  const value = snapshot.value;
  if (!value || !value.priceCatalog && overrides === undefined) return snapshot.priceProjection
    ? { ...snapshot, priceProjection: undefined } : snapshot;
  const retained = snapshot.priceProjection;
  if (retained?.input === value && retained.costBasis === snapshot.query.costBasis && sameStrictJsonValue(retained.overrides, overrides)) return snapshot;
  // Evidence flags can share one admitted accounting response. Reuse that
  // response's projection already held by a sibling in this same read, rather
  // than repricing and retaining the complete contribution population again.
  for (const sibling of siblings ?? []) {
    const projection = sibling.priceProjection;
    if (projection?.input === value && projection.costBasis === snapshot.query.costBasis
      && sameStrictJsonValue(projection.overrides, overrides)) return { ...snapshot, priceProjection: projection };
  }
  return { ...snapshot, priceProjection: { input: value, overrides, costBasis: snapshot.query.costBasis,
    value: repriceUsageAnalyticsResponse(value, value.priceCatalog, overrides, snapshot.query.costBasis) } };
}

/** Carry the admitted accounting reduction through this read's independent source publications. */
export function projectUsageAccountingSnapshotCalendar(snapshot: UsageAccountingSourceSnapshot,
  siblings?: Iterable<UsageAccountingSourceSnapshot>,
  witnessedPeriod?: Readonly<{ startMs: number; endMs: number }>): UsageAccountingSourceSnapshot {
  const query = snapshot.query;
  const value = snapshot.priceProjection && snapshot.priceProjection.input === snapshot.value
    && snapshot.priceProjection.costBasis === query.costBasis ? snapshot.priceProjection.value : snapshot.value;
  const range = witnessedPeriod ?? ('relative' in query.period ? readBoundedAccountingPeriod(value) ?? snapshot.period : snapshot.period ?? query.period);
  if (!value || !query.includeAccounting || !query.includeActivity && !query.includeModelTimeline
    || !canRetainUsageReadFailure(snapshot.errorCode) || range?.endMs === undefined) return snapshot.agentCalendarAccounting
    ? { ...snapshot, agentCalendarAccounting: undefined } : snapshot;
  const period = { startMs: range.startMs ?? 0, endMs: range.endMs };
  if (period.endMs < period.startMs) return snapshot.agentCalendarAccounting ? { ...snapshot, agentCalendarAccounting: undefined } : snapshot;
  const matches = (projection: UsageAgentAccountingCalendar | undefined) => projection?.accounting === value
    && projection.period.startMs === period.startMs && projection.period.endMs === period.endMs
    && projection.timeZoneOffsetMinutes === query.timeZoneOffsetMinutes && projection.costMode === query.costBasis;
  if (matches(snapshot.agentCalendarAccounting)) return snapshot;
  for (const sibling of siblings ?? []) {
    if (matches(sibling.agentCalendarAccounting)) return { ...snapshot, agentCalendarAccounting: sibling.agentCalendarAccounting };
  }
  return { ...snapshot, agentCalendarAccounting: projectUsageAgentAccountingCalendar({ accounting: value, period,
    timeZoneOffsetMinutes: query.timeZoneOffsetMinutes, costMode: query.costBasis }) };
}

/** A successful read retains producer observation time, never the adapter's clock. */
export function resolveUsageAccountingAsOfMs(value: UsageAnalyticsQueryResponse): number | undefined {
  const times = value.coverage?.sources.filter(source => source.status === 'available' || source.status === 'partial')
    .flatMap(source => source.asOfMs === undefined ? [] : [source.asOfMs]) ?? [];
  return times.length ? Math.min(...times) : undefined;
}

export type UsageWorkSourceSnapshot = Readonly<{
  query: UsageQuery;
  evidence?: readonly UsageWorkEvidence[];
  branchEvidence?: readonly ScmBranchWorkEvidence[];
  status: UsageQuerySourceState['status'];
  asOfMs?: number;
  errorCode?: string;
}>;

export type UsageHowYouWorkSourceSnapshot = Readonly<{
  query: UsageQuery;
  detail?: UsageHowYouWorkDetailInput;
  errorCode?: string;
  sessionCoverage?: UsageSessionEvidenceCoverage;
  asOfMs?: number;
  nightHours?: UsageWorkIntervalsInput['nightHours'];
}>;

/** Unbounded ranges and ranges without a valid preceding interval have no comparison. */
export function resolveUsageComparisonQuery(candidate: UsageQuery, period?: Readonly<{ startMs?: number; endMs?: number }>): UsageQuery | null {
  const query = normalizeUsageQuery(candidate);
  const { startMs, endMs } = period ?? query.period;
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return null;
  const previousStart = startMs - (endMs - startMs);
  if (previousStart < 0) return null;
  return normalizeUsageQuery({ ...query, period: { startMs: previousStart, endMs: startMs } });
}

export function resolveUsagePageAccountingReads(queries: readonly UsageQuery[], nowMs: number): Readonly<{ query: UsageQuery; period: ReturnType<typeof resolveUsageQueryPeriod> }>[] {
  const requests = new Map<string, Readonly<{ query: UsageQuery; period: ReturnType<typeof resolveUsageQueryPeriod> }>>();
  for (const candidate of queries) {
    const query = normalizeUsageQuery(candidate);
    if (!query.includeAccounting) continue;
    const period = resolveUsageQueryPeriod(query, nowMs);
    requests.set(getUsageQueryKey(query), { query, period });
    const comparison = resolveUsageComparisonQuery(query, period);
    if (comparison) requests.set(getUsageQueryKey(comparison), { query: comparison, period: comparison.period });
  }
  return [...requests.values()];
}

export function resolveUsagePageAccountingRequests(queries: readonly UsageQuery[], nowMs = Date.now()): UsageQuery[] {
  return resolveUsagePageAccountingReads(queries, nowMs).map(read => read.query);
}

export function canRetainUsageReadFailure(errorCode?: string): boolean {
  return !['denied', 'permission_denied', 'unauthorized', 'forbidden', 'stale_surface', 'cancelled'].includes(errorCode ?? '');
}

function isUsageDetailSourceReadable(source: UsageQuerySourceState): boolean {
  return source.source === 'how_you_work' && ['available', 'partial', 'stale', 'pending'].includes(source.status)
    && canRetainUsageReadFailure(source.errorCode);
}

export function retainAccountingOnReadFailure(observed: UsageAccountingSourceSnapshot | undefined,
  value: UsageAnalyticsQueryResponse | undefined, asOfMs: number | undefined): UsageAccountingSourceSnapshot | undefined {
  // Authority loss/cancellation never revives previously disclosed facts.
  if (!observed || observed.value !== undefined || value === undefined || observed.status !== 'error'
    || !canRetainUsageReadFailure(observed.errorCode)) return observed;
  return { ...observed, value, ...(asOfMs === undefined ? {} : { asOfMs }) };
}

/**
 * One deterministic page composition over already-authorized owner snapshots.
 * No accounting, vendor refresh, transport, cache or authority is invented here.
 */
export type UsagePageAggregationInput = Readonly<{
  queries: readonly UsageQuery[];
  accounting?: readonly UsageAccountingSourceSnapshot[];
  work?: readonly UsageWorkSourceSnapshot[];
  howYouWork?: readonly UsageHowYouWorkSourceSnapshot[];
  /** Account preference is available independently of private Session detail; null explicitly clears it. */
  nightHours?: UsageWorkIntervalsInput['nightHours'] | null;
  nowMs?: number;
  quota?: Readonly<Omit<UsageQuerySourceState, 'source'> & { value?: readonly ConnectedServiceQuotaGetResultV1[] }>;
  pools?: readonly UsagePoolSourceSnapshot[];
  sources?: readonly UsageQuerySourceState[];
  /** Already-opened machine labels authorized for this Account; absence withdraws retained labels. */
  sourceLocations?: readonly Readonly<{ machineId: string; displayLocation: string }>[];
  previous?: UsageQueryBatchResult;
  pricingOverrides?: UsageModelPriceOverridesV1;
  coachPreferences?: UsageCoachPreferencesV1 | null;
}>;

/** Shared B admission and source projection for accounting-backed and quota-only slices. */
function projectUsageQuotaFields(quota: UsagePageAggregationInput['quota'], observedPools: readonly UsageQueryPoolSnapshot[] | undefined,
  previousPools?: readonly UsageQueryPoolSnapshot[]) {
  const pools = observedPools?.map(pool => {
    const previous = previousPools?.find(candidate => sameStrictJsonValue(candidate.group, pool.group));
    if (!previous?.selection.value || !canRetainUsageReadFailure(pool.selection.errorCode)
      || (!['pending', 'not_loaded', 'error'].includes(pool.selection.status) && pool.selection.errorCode !== 'no_machine') || pool.selection.value
      || (pool.selection.machineId !== previous.selection.machineId && pool.selection.errorCode !== 'no_machine')
      || pool.activeAccountId !== previous.activeAccountId || !sameStrictJsonValue(pool.memberAccountIds, previous.memberAccountIds)) return pool;
    return { ...pool, selection: { ...pool.selection, machineId: previous.selection.machineId, value: previous.selection.value,
      status: 'stale' as const, ...(previous.selection.asOfMs === undefined ? {} : { asOfMs: previous.selection.asOfMs }) } };
  });
  const sources: UsageQuerySourceState[] = [
    { source: 'quota', status: quota?.status ?? 'not_loaded',
      ...(quota?.asOfMs === undefined ? {} : { asOfMs: quota.asOfMs }),
      ...(quota?.errorCode === undefined ? {} : { errorCode: quota.errorCode }) },
    ...(pools?.map(pool => ({ source: `selection:${pool.group.service.pluginId}/${pool.group.service.localId}:${pool.group.groupId}`,
      status: pool.selection.status, ...(pool.selection.asOfMs === undefined ? {} : { asOfMs: pool.selection.asOfMs }),
      ...(pool.selection.errorCode === undefined ? {} : { errorCode: pool.selection.errorCode }) })) ?? []),
  ];
  return { sources,
    ...(quota?.value && ['available', 'partial', 'stale'].includes(quota.status) ? { quota: [...quota.value] } : {}),
    ...(pools ? { pools: pools.map(pool => ({ ...pool, selection: ['available', 'stale'].includes(pool.selection.status)
      ? pool.selection : { ...pool.selection, value: undefined } })) } : {}),
  };
}

/** Quota-only demand uses the same admitted B snapshots and result identity, without touching A or private evidence. */
export function resolveUsageQuotaPageAggregation(input: Pick<UsagePageAggregationInput, 'queries' | 'quota' | 'pools' | 'sources' | 'previous' | 'nowMs'>): UsageQueryBatchResult {
  const poolsByQuery = new Map(input.pools?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
  const queries = new Map(input.queries.map(candidate => {
    const query = normalizeUsageQuery(candidate);
    if (query.includeAccounting) throw new Error('Quota-only projection requires quota-only demand');
    return [getUsageQueryKey(query), query] as const;
  }));
  const results = [...queries].map(([key, query]): UsageQueryResultSlice => {
    const { sources: quotaSources, ...quotaFields } = projectUsageQuotaFields(input.quota, poolsByQuery.get(key),
      input.previous?.results.find(slice => slice.key === key)?.pools);
    const sources: UsageQuerySourceState[] = [
      { source: 'accounting', status: 'unsupported' },
      { source: 'work', status: 'not_loaded' },
      { source: 'how_you_work', status: 'not_loaded' },
      ...quotaSources,
      ...(input.sources ?? []).filter(source => source.source.startsWith('quota:')),
    ];
    return { key, requestedQuery: query, shownQuery: query,
      ...quotaFields,
      sources, pending: sources.some(source => (source.source === 'quota' || source.source.startsWith('quota:') || source.source.startsWith('selection:'))
        && (source.status === 'pending' || source.status === 'not_loaded')) };
  });
  return retainUsageQueryResultReferences({ v: 1, results }, input.previous);
}

export function resolveUsagePageAggregation(input: UsagePageAggregationInput): UsageQueryBatchResult {
  const queries = new Map<string, UsageQuery>();
  for (const candidate of input.queries) {
    const query = normalizeUsageQuery(candidate);
    const key = getUsageQueryKey(query);
    if (!queries.has(key)) queries.set(key, query);
  }
  const accounting = new Map<string, UsageAccountingSourceSnapshot>(input.accounting?.map(snapshot => [getUsageQueryKey(snapshot.query), {
    ...snapshot,
    asOfMs: snapshot.asOfMs ?? (snapshot.value ? resolveUsageAccountingAsOfMs(snapshot.value) : undefined),
  }]));
  const sourceLocations = new Map(input.sourceLocations?.map(location => [location.machineId, location.displayLocation]));
  const projectSourceLocations = (value: UsageAnalyticsQueryResponse) => {
    const coverage = value.coverage;
    if (!coverage) return value;
    const known = accountingSourceLocationProjections.get(value);
    if (known && sameStrictJsonValue(known.locations, input.sourceLocations)) return known.value;
    const sources = coverage.sources.map(candidate => {
      // Facts were admitted by the A boundary. Only the authorized client label
      // can expire here; removing it does not require parsing those facts again.
      const current = candidate as typeof candidate & { displayLocation?: string };
      const displayLocation = candidate.machineId ? sourceLocations.get(candidate.machineId) : undefined;
      if (current.displayLocation === displayLocation && (displayLocation !== undefined || !('displayLocation' in current))) return candidate;
      const { displayLocation: _previous, ...source } = current;
      return { ...source, ...(displayLocation === undefined ? {} : { displayLocation }) };
    });
    const projected = sources.every((source, index) => source === coverage.sources[index]) ? value
      : { ...value, coverage: { ...coverage, sources } };
    accountingSourceLocationProjections.set(value, { locations: input.sourceLocations, value: projected });
    return projected;
  };
  const projectPrices = (snapshot: UsageAccountingSourceSnapshot | undefined) => {
    if (!snapshot) return snapshot;
    const projected = projectUsageAccountingSnapshotPrices(snapshot, input.pricingOverrides, accounting.values());
    const key = getUsageQueryKey(projected.query);
    if (accounting.get(key)?.value === projected.value) accounting.set(key, projected);
    return projected.priceProjection ? { ...projected, value: projected.priceProjection.value } : projected;
  };
  const work = new Map(input.work?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
  const howYouWork = new Map(input.howYouWork?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
  const poolsByQuery = new Map(input.pools?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
  const previous = new Map(input.previous?.results.map(slice => [slice.key, slice]));
  const results = [...queries].map(([key, query]) => {
    if (!query.includeAccounting) return resolveUsageQuotaPageAggregation({ ...input, queries: [query] }).results[0]!;
    const observed = accounting.get(key);
    const prior = previous.get(key);
    const pools = poolsByQuery.get(key);
    const { sources: quotaSources, ...quotaFields } = projectUsageQuotaFields(input.quota, pools, prior?.pools);
    const snapshot = projectPrices(retainAccountingOnReadFailure(observed, prior?.accounting,
      prior?.sources.find(source => source.source === 'accounting')?.asOfMs));
    const readPeriod = observed?.period ?? (input.nowMs !== undefined ? resolveUsageQueryPeriod(query, input.nowMs)
      : 'relative' in query.period ? snapshot?.value?.coverage?.range ?? query.period : query.period);
    // A failed refresh retains the prior accounting window as well as its
    // values; it cannot compare those values against a later requested range.
    const period = 'relative' in query.period ? readBoundedAccountingPeriod(snapshot?.value) ?? readPeriod : readPeriod;
    const comparisonQuery = resolveUsageComparisonQuery(query, period);
    const previousComparison = comparisonQuery && prior?.comparison
      && getUsageQueryKey(prior.comparison.query) === getUsageQueryKey(comparisonQuery) ? prior.comparison : undefined;
    const comparisonSnapshot = comparisonQuery ? projectPrices(retainAccountingOnReadFailure(accounting.get(getUsageQueryKey(comparisonQuery)),
      previousComparison?.accounting, previousComparison?.source.asOfMs)) : undefined;
    const comparisonSource: UsageQuerySourceState = { source: 'comparison', status: comparisonSnapshot?.status ?? 'not_loaded',
      ...(comparisonSnapshot?.asOfMs === undefined ? {} : { asOfMs: comparisonSnapshot.asOfMs }),
      ...(comparisonSnapshot?.errorCode === undefined ? {} : { errorCode: comparisonSnapshot.errorCode }) };
    const workSnapshot = work.get(key);
    const detailSnapshot = howYouWork.get(key);
    const detailAuthorized = canRetainUsageReadFailure(detailSnapshot?.errorCode);
    const observedDetail = detailAuthorized ? detailSnapshot?.detail : undefined;
    const pendingDetail = !detailSnapshot && input.sources?.some(source => source.source === 'how_you_work' && source.status === 'pending');
    // A failed replacement has no new admission. A supplied detail (including
    // an unknown/refused result) supersedes old facts even if another read failed.
    const failedDetail = detailSnapshot?.errorCode !== undefined && !detailSnapshot.detail && detailAuthorized;
    // Public detail cannot retain turns that the current accounting population
    // no longer admits. Ordinary personal-history refresh keeps its existing behavior.
    const canRetainDetail = query.population !== 'public_eligible_personal' || hasSameUsageQueryWorkEvidenceMembership({
      query, contributions: snapshot?.value?.contributions, previousContributions: prior?.accounting?.contributions,
    });
    const retainedDetail = canRetainDetail && (pendingDetail || failedDetail) ? prior : undefined;
    const retainedNightHours = retainedDetail?.howYouWork?.nightShift;
    // Missing evidence on an ordinary failed read is not a replacement. An
    // explicit empty admission/quarantine still withdraws the old witnesses.
    const failedWork = workSnapshot?.status === 'error' && workSnapshot.evidence === undefined
      && workSnapshot.branchEvidence === undefined && canRetainUsageReadFailure(workSnapshot.errorCode) && prior?.work !== undefined;
    const retainWork = workSnapshot?.status === 'pending' || failedWork;
    const workAsOfMs = failedWork ? prior?.sources.find(source => source.source === 'work')?.asOfMs : workSnapshot?.asOfMs;
    // Retained evidence remains attached to this exact query while its owner
    // rereads it. Allocation always recomputes over the current contributions;
    // a terminal refusal below removes that previously admitted evidence.
    const workEvidence = retainWork ? prior?.work?.allocations.flatMap(row => row.evidence) ?? []
      : workSnapshot && ['available', 'partial', 'stale'].includes(workSnapshot.status) ? workSnapshot.evidence ?? [] : [];
    const branchEvidence = retainWork ? prior?.work?.branchAllocations.flatMap(row => row.evidence) ?? []
      : workSnapshot && ['available', 'partial', 'stale'].includes(workSnapshot.status) ? workSnapshot.branchEvidence ?? [] : [];
    // An open query is projected only up to a witnessed source as-of. It is not
    // relabelled as a different bounded query or filled forward to this clock.
    const startMs = period.startMs ?? 0;
    const endMs = period.endMs ?? detailSnapshot?.asOfMs;
    const calendarSnapshot = snapshot && endMs !== undefined && endMs >= startMs
      ? projectUsageAccountingSnapshotCalendar(snapshot, accounting.values(), { startMs, endMs }) : undefined;
    const currentSnapshot = accounting.get(key);
    if (calendarSnapshot && currentSnapshot && currentSnapshot.value === observed?.value) accounting.set(key,
      { ...currentSnapshot, agentCalendarAccounting: calendarSnapshot.agentCalendarAccounting });
    const detailProjection = endMs === undefined || endMs < startMs ? undefined : resolveUsageHowYouWork({
      period: { startMs, endMs }, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes,
      accounting: snapshot?.value, detail: observedDetail,
      accountingCalendar: calendarSnapshot?.agentCalendarAccounting,
      includeSteering: query.includeTranscriptEvidence,
      includeAgentCalendar: query.includeActivity || query.includeModelTimeline,
      costMode: query.costBasis,
      sessionCoverage: detailAuthorized ? detailSnapshot?.sessionCoverage : undefined,
      retained: retainedDetail?.howYouWork,
      nowMs: input.nowMs ?? detailSnapshot?.asOfMs,
      nightHours: input.nightHours === undefined ? detailSnapshot?.nightHours ?? (retainedNightHours
        ? { startHour: retainedNightHours.startHour, endHour: retainedNightHours.endHour } : undefined) : input.nightHours ?? undefined,
    });
    const admittedDetail = observedDetail?.status === 'unknown' ? undefined : observedDetail;
    const coachEvidence = admittedDetail?.coach;
    const coachAsOfMs = (admittedDetail ? detailSnapshot?.asOfMs : undefined) ?? snapshot?.asOfMs ?? retainedDetail?.coach?.asOfMs ?? null;
    const coachEndMs = endMs ?? coachAsOfMs;
    const coach = coachEndMs === null || coachEndMs === undefined || coachEndMs < startMs ? undefined : evaluateUsageCoach({
      ...coachEvidence,
      ...(admittedDetail ? { detail: { ...coachEvidence?.detail,
        coverage: coachEvidence?.detail?.coverage ?? 'partial',
        ...(admittedDetail.permissions === undefined ? {} : { permissions: admittedDetail.permissions }),
      } } : {}),
      queryKey: key, period: { startMs, endMs: coachEndMs }, asOfMs: coachAsOfMs,
      currentness: coachAsOfMs === null ? 'unknown' : detailSnapshot?.errorCode || snapshot?.status === 'error' || snapshot?.status === 'stale' ? 'stale'
        : snapshot?.status === 'available' || admittedDetail ? 'current' : 'unknown',
      accounting: snapshot?.value,
      pricingOverrides: input.pricingOverrides,
      preferences: input.coachPreferences,
    });
    // Source-only initial progress has no observed Coach evidence to retain.
    // It must not replace the first accounting-backed evaluation while detail loads.
    const retainedCoach = input.coachPreferences === null || retainedDetail?.coach?.asOfMs === null ? undefined : retainedDetail?.coach;
    const retainedEvaluations = retainedCoach?.evaluations.map(evaluation => {
      const configured = coach?.evaluations.find(row => row.detectorId === evaluation.detectorId);
      // Retention must not revive evidence that the current evaluator's configuration refuses.
      if (configured?.status === 'disabled' || evaluation.status === 'disabled' || evaluation.detectorId === 'model_misfit'
        && input.coachPreferences?.modelSuggestion === 'complete_only') return configured ?? evaluation;
      return evaluation.status === 'finding'
        ? { ...evaluation, finding: { ...evaluation.finding, currentness: 'stale' as const, remedy: null, action: null } } : evaluation;
    });
    const coachProjection = retainedCoach && retainedEvaluations ? { ...retainedCoach, currentness: 'stale' as const,
      evaluations: retainedEvaluations, findings: retainedEvaluations.flatMap(evaluation => evaluation.status === 'finding' ? [evaluation.finding] : []) } : coach;
    const digestSuggestion = coachProjection && createUsageCoachDigestSuggestion(query, coachProjection.period);
    const detailSourceStatus: UsageQuerySourceState['status'] = !detailSnapshot?.errorCode ? detailProjection?.detailStatus ?? 'unknown'
      : detailAuthorized && (retainedDetail?.howYouWork || observedDetail && observedDetail.status !== 'unknown') ? 'stale' : 'error';
    const detailAsOfMs = detailSnapshot?.asOfMs ?? retainedDetail?.sources.find(source => source.source === 'how_you_work')?.asOfMs;
    const sources: UsageQuerySourceState[] = [
      { source: 'accounting', status: snapshot?.status ?? 'not_loaded',
        ...(snapshot?.asOfMs === undefined ? {} : { asOfMs: snapshot.asOfMs }),
        ...(snapshot?.errorCode === undefined ? {} : { errorCode: snapshot.errorCode }) },
      ...(snapshot?.value?.coverage?.sources.map(source => ({ source: source.source, status: source.status,
        ...(source.asOfMs === undefined ? {} : { asOfMs: source.asOfMs }) })) ?? []),
      ...quotaSources,
      { source: 'work', status: failedWork ? 'stale' : workSnapshot?.status ?? 'not_loaded',
        ...(workAsOfMs === undefined ? {} : { asOfMs: workAsOfMs }),
        ...(workSnapshot?.errorCode === undefined ? {} : { errorCode: workSnapshot.errorCode }) },
      // An exact-query detail snapshot supersedes the batch-wide initial
      // source. Retaining both lets an unfinished sibling keep this slice
      // pending after its own private evidence has answered.
      ...(query.includeSessionEvidence ? (input.sources ?? []).filter(source => !detailSnapshot || source.source !== 'how_you_work') : [
        ...(input.sources ?? []).filter(source => source.source !== 'how_you_work'),
        { source: 'how_you_work', status: 'not_loaded' as const },
      ]),
      ...(detailSnapshot ? [{ source: 'how_you_work', status: detailSourceStatus,
        ...(detailSnapshot.errorCode === undefined ? {} : { errorCode: detailSnapshot.errorCode }),
        ...(detailAsOfMs === undefined ? {} : { asOfMs: detailAsOfMs }) }] : []),
    ];
    // Inputs are admitted owner snapshots; this projection is not a wire boundary.
    // Parsing here clones the same full history for every widget on every source
    // revision. Keep its identity and validate the batch at the Action/Resource boundary.
    const workProjection = !query.includeWorkEvidence || snapshot?.value?.contributions === undefined ? undefined : allocateUsageOutcomes({
      contributions: snapshot.value.contributions, evidence: workEvidence, branchEvidence,
    });
    const mergedOutcomes = workProjection && endMs !== undefined && endMs >= startMs
      // An allocation scaffold also exists before Work has ever been read.
      // Only an observed summary can retain known counts through a reread.
      && (retainWork && prior?.mergedOutcomes !== undefined || workSnapshot && ['available', 'partial', 'stale'].includes(workSnapshot.status))
      ? summarizeUsageMergedOutcomes({ work: workProjection, period: { startMs, endMs }, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes }) : undefined;
    const slice: UsageQueryResultSlice = {
      key, requestedQuery: query, shownQuery: query,
      ...(snapshot?.value === undefined ? {} : { accounting: projectSourceLocations(snapshot.value), costFactTotals: projectUsageCostFactTotals(snapshot.value.costFacts ?? []) }),
      planInsights: projectUsagePlanInsights({ query: { ...query, period }, nowMs: input.nowMs, accounting: snapshot?.value, accountingAsOfMs: snapshot?.asOfMs,
        howYouWork: detailProjection,
        quota: input.quota?.value && ['available', 'partial', 'stale'].includes(input.quota.status) ? input.quota.value : undefined }),
      ...quotaFields,
      ...(detailProjection === undefined ? {} : { howYouWork: detailProjection }),
      ...(coachProjection === undefined ? {} : { coach: { ...coachProjection,
        ...(detailProjection?.sessionCoverage === undefined ? {} : { sessionCoverage: detailProjection.sessionCoverage }),
        ...(digestSuggestion === undefined ? {} : { digestSuggestion }),
      } }),
      ...(comparisonQuery ? { comparison: { query: comparisonQuery, source: comparisonSource,
        ...(comparisonSnapshot?.value === undefined ? {} : { accounting: projectSourceLocations(comparisonSnapshot.value), costFactTotals: projectUsageCostFactTotals(comparisonSnapshot.value.costFacts ?? []) }) } } : {}),
      ...(workProjection === undefined ? {} : { work: workProjection }),
      ...(mergedOutcomes === undefined ? {} : { mergedOutcomes }),
      sources,
      pending: [...sources, ...(comparisonQuery ? [comparisonSource] : [])].some(source =>
        (source.status === 'pending' || source.status === 'not_loaded')
        && (source.source === 'work' ? query.includeWorkEvidence
          : source.source === 'how_you_work' ? query.includeSessionEvidence : true)),
    };
    return slice;
  });
  return retainUsageQueryResultReferences({ v: 1, results }, input.previous);
}
