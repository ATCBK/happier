import { z } from 'zod';
import type { UsageCoachPreferencesV1 } from '../account/settings/usageCoachPreferencesV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { getUsageQueryKey, normalizeUsageQuery, resolveUsageQueryPeriod, UsageQuerySchema, type UsageQuery } from '../inputs/usageQuery.js';
import { UsageQueryAccountingSchema, UsageAnalyticsSourceCoverageSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { UsageCostFactTotalSchema, projectUsageCostFactTotals } from './usageCostFactTotals.js';
import { allocateUsageOutcomes, UsageWorkProjectionSchema, type UsageWorkEvidence } from './usageOutcomeAllocation.js';
import type { ScmBranchWorkEvidence } from '../scm/branches.js';
import { resolveUsageHowYouWork, UsageHowYouWorkSchema, type UsageHowYouWorkDetailInput } from './resolveUsageHowYouWork.js';
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
export type { UsagePlanInsights } from './usagePlanInsights.js';

/** Source transport currentness is separate from accounting completeness. */
export const UsageQuerySourceStatusSchema = lazyZodSchema(() => z.enum([
  'available', 'stale', 'not_loaded', 'pending', 'error', 'unsupported', 'unknown', 'partial',
]));
export const UsageQuerySourceStateSchema = lazyZodSchema(() => z.object({
  source: z.string().trim().min(1),
  status: UsageQuerySourceStatusSchema,
  asOfMs: z.number().int().nonnegative().optional(),
  errorCode: z.string().trim().min(1).optional(),
}).strict());
export type UsageQuerySourceState = z.infer<typeof UsageQuerySourceStateSchema>;

/** Pool membership is an Account projection, separate from unique B account/window facts. */
export const UsageQueryPoolSnapshotSchema = lazyZodSchema(() => z.object({
  group: QualifiedConnectedAccountGroupRefSchema,
  memberAccountIds: z.array(z.string().trim().min(1)),
  activeAccountId: z.string().trim().min(1).nullable(),
  selection: UsageQuerySourceStateSchema.omit({ source: true }).extend({
    machineId: z.string().trim().min(1).optional(),
    value: ConnectedServicePoolSelectionGetResponseV1Schema.optional(),
  }).strict(),
}).strict().superRefine((pool, context) => {
  const value = pool.selection.value;
  if (value && !['available', 'stale'].includes(pool.selection.status)) {
    context.addIssue({ code: 'custom', path: ['selection'], message: 'Unavailable selector cannot disclose retained decisions' });
  }
  if (value && 'group' in value && !sameStrictJsonValue(value.group, pool.group)) {
    context.addIssue({ code: 'custom', path: ['selection'], message: 'Selector must identify its qualified pool' });
  }
}));
export type UsageQueryPoolSnapshot = z.infer<typeof UsageQueryPoolSnapshotSchema>;
export type UsagePoolSourceSnapshot = Readonly<{ query: UsageQuery; value: readonly UsageQueryPoolSnapshot[] }>;

function readBoundedAccountingPeriod(value: UsageAnalyticsQueryResponse | undefined) {
  const range = value?.coverage?.range;
  return range?.startMs !== undefined && range.endMs !== undefined
    ? { startMs: range.startMs, endMs: range.endMs } : undefined;
}

export const UsageQueryResultSliceSchema = lazyZodSchema(() => z.object({
  key: z.string().min(1),
  requestedQuery: UsageQuerySchema,
  shownQuery: UsageQuerySchema,
  accounting: UsageQueryAccountingSchema.optional(),
  costFactTotals: z.array(UsageCostFactTotalSchema).optional(),
  quota: z.array(ConnectedServiceQuotaGetResultV1Schema).optional(),
  pools: z.array(UsageQueryPoolSnapshotSchema).optional(),
  planInsights: UsagePlanInsightsSchema.optional(),
  comparison: z.object({ query: UsageQuerySchema, accounting: UsageQueryAccountingSchema.optional(),
    costFactTotals: z.array(UsageCostFactTotalSchema).optional(),
    source: UsageQuerySourceStateSchema }).strict().optional(),
  work: UsageWorkProjectionSchema.optional(),
  howYouWork: UsageHowYouWorkSchema.optional(),
  coach: UsageCoachEvaluationSchema.optional(),
  sources: z.array(UsageQuerySourceStateSchema),
  pending: z.boolean(),
}).strict().superRefine((slice, context) => {
  if (slice.key !== getUsageQueryKey(slice.requestedQuery)) {
    context.addIssue({ code: 'custom', path: ['key'], message: 'Result key must identify the requested query' });
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
  // Retained private evidence can have an older read window during progression.
  // Accounting comparisons and calendar facts belong to the witnessed A window.
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
  if (intervals && !slice.sources.some(source => source.source === 'how_you_work' && ['available', 'partial', 'pending'].includes(source.status))) {
    context.addIssue({ code: 'custom', path: ['howYouWork'], message: 'Unavailable detail cannot disclose private intervals' });
  }
  if (slice.coach && (slice.coach.queryKey !== slice.key
    || (slice.shownQuery.period.startMs !== undefined && slice.coach.period.startMs !== slice.shownQuery.period.startMs)
    || (slice.shownQuery.period.endMs !== undefined && slice.coach.period.endMs !== slice.shownQuery.period.endMs))) {
    context.addIssue({ code: 'custom', path: ['coach'], message: 'Coach must identify the exact admitted query period' });
  }
  if (slice.coach?.findings.some(finding => finding.evidence.some(evidence => evidence.kind !== 'accounting'))
    && !slice.sources.some(source => source.source === 'how_you_work' && ['available', 'partial', 'stale', 'pending'].includes(source.status))) {
    context.addIssue({ code: 'custom', path: ['coach'], message: 'Unavailable detail cannot disclose private Coach evidence' });
  }
}));
export type UsageQueryResultSlice = z.infer<typeof UsageQueryResultSliceSchema>;

export const UsageQueryBatchResultSchema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  results: z.array(UsageQueryResultSliceSchema),
}).strict().superRefine((batch, context) => {
  const keys = new Set<string>();
  batch.results.forEach((slice, index) => {
    if (keys.has(slice.key)) context.addIssue({ code: 'custom', path: ['results', index, 'key'], message: 'Duplicate query slice' });
    keys.add(slice.key);
  });
}));
export type UsageQueryBatchResult = z.infer<typeof UsageQueryBatchResultSchema>;

/** Reuse semantically unchanged validated slices from the caller's same-authority prior value. */
export function retainUsageQueryResultReferences(current: UsageQueryBatchResult,
  previous: UsageQueryBatchResult | undefined): UsageQueryBatchResult {
  if (!previous) return current;
  const prior = new Map(previous.results.map(slice => [slice.key, slice]));
  const results = current.results.map(slice => {
    const retained = prior.get(slice.key);
    return retained && sameStrictJsonValue(retained, slice) ? retained : slice;
  });
  if (results.length === previous.results.length
    && results.every((slice, index) => slice === previous.results[index])) return previous;
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
}>;

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
  detail: UsageHowYouWorkDetailInput;
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

function retainAccountingOnReadFailure(observed: UsageAccountingSourceSnapshot | undefined,
  value: UsageAnalyticsQueryResponse | undefined, asOfMs: number | undefined): UsageAccountingSourceSnapshot | undefined {
  // Authority loss/cancellation never revives previously disclosed facts.
  if (!observed || observed.value !== undefined || value === undefined || observed.status !== 'error'
    || ['denied', 'permission_denied', 'unauthorized', 'forbidden', 'stale_surface', 'cancelled'].includes(observed.errorCode ?? '')) return observed;
  return { ...observed, value, ...(asOfMs === undefined ? {} : { asOfMs }) };
}

/**
 * One deterministic page composition over already-authorized owner snapshots.
 * No accounting, vendor refresh, transport, cache or authority is invented here.
 */
export function resolveUsagePageAggregation(input: Readonly<{
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
}>): UsageQueryBatchResult {
  const queries = new Map<string, UsageQuery>();
  for (const candidate of input.queries) {
    const query = normalizeUsageQuery(candidate);
    const key = getUsageQueryKey(query);
    if (!queries.has(key)) queries.set(key, query);
  }
  const accounting = new Map(input.accounting?.map(snapshot => [getUsageQueryKey(snapshot.query), {
    ...snapshot,
    asOfMs: snapshot.asOfMs ?? (snapshot.value ? resolveUsageAccountingAsOfMs(snapshot.value) : undefined),
  }]));
  const sourceLocations = new Map(input.sourceLocations?.map(location => [location.machineId, location.displayLocation]));
  const projectSourceLocations = (value: UsageAnalyticsQueryResponse) => !value.coverage ? value : { ...value,
    coverage: { ...value.coverage, sources: value.coverage.sources.map(candidate => {
      // Retained snapshots can carry old labels. Re-admit only accounting fields before applying current authorization.
      const source = UsageAnalyticsSourceCoverageSchema.strip().parse(candidate);
      const displayLocation = source.machineId ? sourceLocations.get(source.machineId) : undefined;
      return { ...source, ...(displayLocation === undefined ? {} : { displayLocation }) };
    }) } };
  const projectPrices = (snapshot: UsageAccountingSourceSnapshot | undefined) => snapshot?.value
    && (snapshot.value.priceCatalog || input.pricingOverrides !== undefined)
    ? { ...snapshot, value: repriceUsageAnalyticsResponse(snapshot.value, snapshot.value.priceCatalog, input.pricingOverrides, snapshot.query.costBasis) }
    : snapshot;
  const work = new Map(input.work?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
  const howYouWork = new Map(input.howYouWork?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot]));
  const poolsByQuery = new Map(input.pools?.map(snapshot => [getUsageQueryKey(snapshot.query), snapshot.value]));
  const previous = new Map(input.previous?.results.map(slice => [slice.key, slice]));
  const results = [...queries].map(([key, query]) => {
    const observed = accounting.get(key);
    const prior = previous.get(key);
    const pools = poolsByQuery.get(key);
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
    const pendingDetail = !detailSnapshot && input.sources?.some(source => source.source === 'how_you_work' && source.status === 'pending');
    const retainedDetail = pendingDetail ? prior : undefined;
    const retainedNightHours = retainedDetail?.howYouWork?.nightShift;
    // Retained evidence remains attached to this exact query while its owner
    // rereads it. Allocation always recomputes over the current contributions;
    // a terminal refusal below removes that previously admitted evidence.
    const workEvidence = workSnapshot?.status === 'pending' ? prior?.work?.allocations.flatMap(row => row.evidence) ?? []
      : workSnapshot && ['available', 'partial', 'stale'].includes(workSnapshot.status) ? workSnapshot.evidence ?? [] : [];
    const branchEvidence = workSnapshot?.status === 'pending' ? prior?.work?.branchAllocations.flatMap(row => row.evidence) ?? []
      : workSnapshot && ['available', 'partial', 'stale'].includes(workSnapshot.status) ? workSnapshot.branchEvidence ?? [] : [];
    // An open query is projected only up to a witnessed source as-of. It is not
    // relabelled as a different bounded query or filled forward to this clock.
    const startMs = period.startMs ?? 0;
    const endMs = period.endMs ?? detailSnapshot?.asOfMs;
    const detailProjection = endMs === undefined || endMs < startMs ? undefined : resolveUsageHowYouWork({
      period: { startMs, endMs }, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes,
      accounting: snapshot?.value, detail: detailSnapshot?.detail,
      retained: retainedDetail?.howYouWork,
      nowMs: input.nowMs ?? detailSnapshot?.asOfMs,
      nightHours: input.nightHours === undefined ? detailSnapshot?.nightHours ?? (retainedNightHours
        ? { startHour: retainedNightHours.startHour, endHour: retainedNightHours.endHour } : undefined) : input.nightHours ?? undefined,
    });
    const admittedDetail = detailSnapshot?.detail.status === 'unknown' ? undefined : detailSnapshot?.detail;
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
      currentness: coachAsOfMs === null ? 'unknown' : snapshot?.status === 'error' || snapshot?.status === 'stale' ? 'stale'
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
    const sources: UsageQuerySourceState[] = [
      { source: 'accounting', status: snapshot?.status ?? 'not_loaded',
        ...(snapshot?.asOfMs === undefined ? {} : { asOfMs: snapshot.asOfMs }),
        ...(snapshot?.errorCode === undefined ? {} : { errorCode: snapshot.errorCode }) },
      ...(snapshot?.value?.coverage?.sources.map(source => ({ source: source.source, status: source.status,
        ...(source.asOfMs === undefined ? {} : { asOfMs: source.asOfMs }) })) ?? []),
      { source: 'quota', status: input.quota?.status ?? 'not_loaded',
        ...(input.quota?.asOfMs === undefined ? {} : { asOfMs: input.quota.asOfMs }),
        ...(input.quota?.errorCode === undefined ? {} : { errorCode: input.quota.errorCode }) },
      { source: 'work', status: workSnapshot?.status ?? 'not_loaded',
        ...(workSnapshot?.asOfMs === undefined ? {} : { asOfMs: workSnapshot.asOfMs }),
        ...(workSnapshot?.errorCode === undefined ? {} : { errorCode: workSnapshot.errorCode }) },
      ...(query.includeSessionEvidence ? input.sources ?? [] : [
        ...(input.sources ?? []).filter(source => source.source !== 'how_you_work'),
        { source: 'how_you_work', status: 'not_loaded' as const },
      ]),
      ...(pools?.map(pool => ({ source: `selection:${pool.group.service.pluginId}/${pool.group.service.localId}:${pool.group.groupId}`,
        status: pool.selection.status, ...(pool.selection.asOfMs === undefined ? {} : { asOfMs: pool.selection.asOfMs }),
        ...(pool.selection.errorCode === undefined ? {} : { errorCode: pool.selection.errorCode }) })) ?? []),
      ...(detailSnapshot ? [{ source: 'how_you_work', status: detailProjection?.detailStatus ?? 'unknown',
        ...(detailSnapshot.asOfMs === undefined ? {} : { asOfMs: detailSnapshot.asOfMs }) }] : []),
    ];
    // Inputs are admitted owner snapshots; this projection is not a wire boundary.
    // Parsing here clones the same full history for every widget on every source
    // revision. Keep its identity and validate the batch at the Action/Resource boundary.
    const slice: UsageQueryResultSlice = {
      key, requestedQuery: query, shownQuery: query,
      ...(snapshot?.value === undefined ? {} : { accounting: projectSourceLocations(snapshot.value), costFactTotals: projectUsageCostFactTotals(snapshot.value.costFacts ?? []) }),
      planInsights: projectUsagePlanInsights({ query: { ...query, period }, nowMs: input.nowMs, accounting: snapshot?.value, accountingAsOfMs: snapshot?.asOfMs,
        howYouWork: detailProjection,
        quota: input.quota?.value && ['available', 'partial', 'stale'].includes(input.quota.status) ? input.quota.value : undefined }),
      ...(input.quota?.value && ['available', 'partial', 'stale'].includes(input.quota.status) ? { quota: [...input.quota.value] } : {}),
      ...(pools ? { pools: pools.map(pool => ({ ...pool, selection: ['available', 'stale'].includes(pool.selection.status)
        ? pool.selection : { ...pool.selection, value: undefined } })) } : {}),
      ...(detailProjection === undefined ? {} : { howYouWork: detailProjection }),
      ...(coachProjection === undefined ? {} : { coach: { ...coachProjection,
        ...(digestSuggestion === undefined ? {} : { digestSuggestion }),
      } }),
      ...(comparisonQuery ? { comparison: { query: comparisonQuery, source: comparisonSource,
        ...(comparisonSnapshot?.value === undefined ? {} : { accounting: projectSourceLocations(comparisonSnapshot.value), costFactTotals: projectUsageCostFactTotals(comparisonSnapshot.value.costFacts ?? []) }) } } : {}),
      ...(!query.includeWorkEvidence || snapshot?.value?.contributions === undefined ? {} : { work: UsageWorkProjectionSchema.parse(allocateUsageOutcomes({
        contributions: snapshot.value.contributions,
        evidence: workEvidence,
        branchEvidence,
      })) }),
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
