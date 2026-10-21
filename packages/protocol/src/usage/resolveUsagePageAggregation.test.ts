import { describe, expect, it, vi } from 'vitest';
import { normalizeUsageQuery, resolveUsageQueryPeriod } from '../inputs/usageQuery.js';
import { UsageAnalyticsQueryResponseSchema, UsageAnalyticsSourceCoverageSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { resolveUsagePageAggregation, resolveUsagePageAccountingRequests, projectUsageAccountingSnapshotPrices, retainUsageQueryResultReferences, UsageQueryBatchResultSchema } from './resolveUsagePageAggregation.js';
import type { UsageWorkEvidence } from './usageOutcomeAllocation.js';
import { buildProviderAccountUsageRecordId } from '../connect/providerAccountUsagePrimitives.js';
import { ConnectedServiceQuotaGetResultV1Schema } from '../connect/providerAccountUsageHistorySchemasV1.js';
import { projectUsagePlanInsights } from './usagePlanInsights.js';
import { USAGE_COACH_DETECTOR_IDS } from './coach/coachDetectorIds.js';
import { bundledUsageModelPriceCatalog } from './usageModelPriceCatalog.js';
import { readUsageScopeOptions } from './usageFilterOptions.js';
import { projectSessionUsageWorkEvidence, projectUsageQueryWorkEvidence } from './usageWorkEvidence.js';

const tokens = { input: 12, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 16 };
const accounting = UsageAnalyticsQueryResponseSchema.parse({
  v: 1, totals: { eventCount: 1, tokens, cost: { reportedUsd: 0.02, estimatedUsd: 0, currency: 'USD' } },
});

describe('resolveUsagePageAggregation', () => {
  it('withdraws retained public detail when its admitted accounting turns change without changing ordinary retention', () => {
    for (const population of ['all_personal_history', 'public_eligible_personal'] as const) {
      const query = normalizeUsageQuery({ population, period: { startMs: 100, endMs: 1_000 } });
      const value = (turnIds: readonly string[]) => UsageAnalyticsQueryResponseSchema.parse({ ...accounting,
        contributions: turnIds.map(turnId => ({ id: turnId, observedAtMs: 700, sessionId: 'mixed', turnId,
          agentId: turnId === 'old' ? 'claude' : 'codex', modelId: null, machineId: null, projectKey: null,
          workspaceId: null, source: 'runtime', tokens, cost: accounting.totals.cost })),
      });
      const initial = value(['old', 'new']);
      const session = { id: 'mixed', metadata: null, agentState: null,
        sessionTurns: { v: 1 as const, sessionId: 'mixed', updatedAt: 900, turns: [
          { turnId: 'old', agentId: 'claude', status: 'completed' as const, startedAt: 100, terminalAt: 500, updatedAt: 500 },
          { turnId: 'new', agentId: 'codex', status: 'completed' as const, startedAt: 600, terminalAt: 900, updatedAt: 900 },
        ] } };
      const previous = resolveUsagePageAggregation({ queries: [query],
        accounting: [{ query, status: 'available', value: initial }], howYouWork: [{ query, asOfMs: 1_000,
          detail: projectUsageQueryWorkEvidence({ query, sessions: [session], contributions: initial.contributions }),
        }],
      });
      expect(previous.results[0]?.howYouWork?.runLengths?.sampleCount).toBe(2);
      const unchangedMembership = resolveUsagePageAggregation({ queries: [query], previous,
        accounting: [{ query, status: 'available', value: value(['new', 'old']) }],
        sources: [{ source: 'how_you_work', status: 'pending' }],
      });
      expect(unchangedMembership.results[0]?.howYouWork).toEqual(previous.results[0]?.howYouWork);
      const refreshed = resolveUsagePageAggregation({ queries: [query], previous,
        accounting: [{ query, status: 'available', value: value(['new']) }],
        sources: [{ source: 'how_you_work', status: 'pending' }],
      });
      if (population === 'public_eligible_personal') {
        expect(refreshed.results[0]?.howYouWork).toMatchObject({ detailStatus: 'unknown', intervals: null, runLengths: null });
      } else expect(refreshed.results[0]?.howYouWork).toEqual(previous.results[0]?.howYouWork);
    }
  });

  it('carries shared chart summaries through the real query projection and withdraws refused detail', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeActivity: true });
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, contributions: [{
      id: 'one', observedAtMs: 150, sessionId: 'session', turnId: 'turn', agentId: 'claude', modelId: null,
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens, cost: accounting.totals.cost,
    }] });
    const witness: UsageWorkEvidence = { sessionId: 'session', turnId: 'turn', repositoryKey: 'repo',
      checkpointRef: 'checkpoint', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Private title', url: 'https://github.com/owner/repo/pull/1',
        baseBranch: 'main', headBranch: 'feature', state: 'merged',
      } };
    const project = () => resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value }], work: [{ query, status: 'partial', evidence: [witness] }],
      howYouWork: [{ query, asOfMs: 200, detail: { status: 'partial',
        facts: [{ workId: 'work', evidenceId: 'turn', agentId: 'claude', machineId: null, kind: 'busy', startMs: 110, endMs: 150 }],
        closedTurns: [{ workId: 'work', agentId: 'claude', status: 'completed', startMs: 110, endMs: 150 }],
        acceptedInputs: [{ inputId: 'steer', workId: 'work', turnId: 'turn', acceptedAtMs: 120, deliveryKind: 'steer' }],
        collaboration: [{ evidenceId: 'child', workId: 'work', sourceSessionId: 'session', targetId: 'child',
          sourceAgentId: 'claude', targetAgentId: 'codex', observedAtMs: 130, relation: 'native' }],
      } }],
    });
    const first = project();
    expect(first.results[0]?.howYouWork).toMatchObject({ runLengths: { sampleCount: 1 },
      steering: { byAgent: [expect.objectContaining({ agentId: 'claude', steeringCount: 1 })] },
      collaboration: { edges: [{ sourceAgentId: 'claude', targetAgentId: 'codex', relation: 'native', count: 1 }] },
      agentCalendar: { days: [expect.objectContaining({ totals: expect.objectContaining({ tokens: 16 }) })] },
    });
    expect(first.results[0]?.mergedOutcomes).toMatchObject({ linkedMergedCount: 1, undatedMergedCount: 1 });
    expect(UsageQueryBatchResultSchema.safeParse(first).success).toBe(true);
    expect(UsageQueryBatchResultSchema.safeParse({ ...first, results: [{ ...first.results[0],
      mergedOutcomes: { ...first.results[0]!.mergedOutcomes, undatedMergedCount: 99 },
    }] }).success).toBe(false);
    const refused = resolveUsagePageAggregation({ queries: [query], previous: first,
      accounting: [{ query, status: 'available', value }], howYouWork: [{ query, detail: { status: 'unknown' } }],
      work: [{ query, status: 'error', evidence: [], errorCode: 'permission_denied' }],
    });
    expect(refused.results[0]?.howYouWork).toMatchObject({ runLengths: null, steering: null, collaboration: null });
    expect(refused.results[0]?.mergedOutcomes).toBeUndefined();
    expect(UsageQueryBatchResultSchema.safeParse(refused).success).toBe(true);
    expect(UsageQueryBatchResultSchema.safeParse({ ...refused, results: [{ ...refused.results[0],
      howYouWork: { ...refused.results[0]!.howYouWork, agentCalendar: first.results[0]!.howYouWork!.agentCalendar },
    }] }).success).toBe(false);
    const calendar = first.results[0]!.howYouWork!.agentCalendar!;
    const withoutPrivateMetrics = (metrics: typeof calendar.periodSummary.totals) => ({
      ...metrics, busyMs: null, steeringCount: null, peakParallel: null,
    });
    const accountingPeriod = { ...calendar.periodSummary, totals: withoutPrivateMetrics(calendar.periodSummary.totals),
      agents: calendar.periodSummary.agents.map(agent => ({ ...agent, metrics: withoutPrivateMetrics(agent.metrics) })),
    };
    expect(UsageQueryBatchResultSchema.safeParse({ ...refused, results: [{ ...refused.results[0],
      howYouWork: { ...refused.results[0]!.howYouWork, agentCalendar: { ...calendar,
        coverage: { ...calendar.coverage, busy: 'unavailable', steering: 'unavailable' },
        periodSummary: accountingPeriod, days: [], weeks: [], hours: [], hourOfDayBuckets: [], weeklyPeakParallel: [],
      } },
    }] }).success).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse({ ...refused, results: [{ ...refused.results[0],
      howYouWork: { ...refused.results[0]!.howYouWork, agentCalendar: { ...calendar,
        coverage: { ...calendar.coverage, busy: 'unavailable', steering: 'unavailable' },
        periodSummary: accountingPeriod, days: [], weeks: [], hours: [], weekdayHourBuckets: [], weeklyPeakParallel: [],
      } },
    }] }).success).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse({ ...refused, results: [{ ...refused.results[0],
      howYouWork: { ...refused.results[0]!.howYouWork, agentCalendar: { ...calendar,
        coverage: { ...calendar.coverage, busy: 'unavailable', steering: 'unavailable' },
        days: [], weeks: [], hours: [], weekdayHourBuckets: [], hourOfDayBuckets: [], weeklyPeakParallel: [],
      } },
    }] }).success).toBe(false);
  });
  it('publishes one answered-approval population from opened Session evidence to Coach and Human loop', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const completion = { tool: 'Bash', createdAt: 110, completedAt: 140, status: 'approved' };
    const detail = projectSessionUsageWorkEvidence({ id: 'session', metadata: null, agentState: { completedRequests: {
      within: completion, earlier: { ...completion, createdAt: 90 },
      immediate: { ...completion, createdAt: 150, completedAt: 150 },
    } } });
    const result = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: accounting }],
      howYouWork: [{ query, asOfMs: 200, detail }],
    });
    const slice = result.results[0]!;
    expect(slice.howYouWork?.permissions).toMatchObject({ pairedDecisionCount: 3, decisionLatencyMs: 80 });
    expect(slice.coach?.findings.find(row => row.detectorId === 'approval_friction')?.measurements)
      .toEqual(expect.arrayContaining([{ metric: 'permission_requests', value: 3, unit: 'count' },
        { metric: 'permission_wait', value: 80, unit: 'milliseconds' }]));
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
  });
  it('carries admitted Session coverage independently of accounting and interval facts through retry and retirement', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const project = (selected: number, admitted: number) => resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, status: 'available', value: accounting }],
      howYouWork: [{ query, asOfMs: 200, sessionCoverage: { selected, admitted },
        detail: { status: admitted < selected ? 'partial' : 'available', facts: [] } }],
    });
    const partial = project(5, 3);
    for (const value of [partial.results[0]?.howYouWork, partial.results[0]?.coach]) {
      expect(value?.sessionCoverage).toEqual({ selected: 5, admitted: 3 });
    }
    expect(partial.results[0]?.howYouWork?.detailStatus).toBe('partial');
    expect(UsageQueryBatchResultSchema.safeParse(partial).success).toBe(true);
    const pending = resolveUsagePageAggregation({ queries: [query], previous: partial,
      sources: [{ source: 'how_you_work', status: 'pending' }] });
    expect(pending.results[0]?.coach?.sessionCoverage).toEqual({ selected: 5, admitted: 3 });
    const recovered = project(5, 5);
    expect(recovered.results[0]?.howYouWork?.sessionCoverage).toEqual({ selected: 5, admitted: 5 });
    expect(recovered.results[0]?.coach?.sessionCoverage).toEqual({ selected: 5, admitted: 5 });
    expect(recovered.results[0]?.howYouWork?.intervals?.agentTimeMs).toBe(0);
    expect(project(0, 0).results[0]?.coach?.sessionCoverage).toEqual({ selected: 0, admitted: 0 });
    const refused = resolveUsagePageAggregation({ queries: [query], previous: recovered,
      howYouWork: [{ query, detail: { status: 'unknown' } }] });
    expect(refused.results[0]?.howYouWork?.sessionCoverage).toBeUndefined();
    expect(refused.results[0]?.coach?.sessionCoverage).toBeUndefined();
    expect(UsageQueryBatchResultSchema.safeParse({ ...partial, results: [{ ...partial.results[0],
      howYouWork: { ...partial.results[0]!.howYouWork, sessionCoverage: { selected: 3, admitted: 5 } },
    }] }).success).toBe(false);
  });
  it('updates authorized source labels without reparsing admitted source facts on refresh', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeSessionEvidence: false, includeWorkEvidence: false });
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, coverage: { status: 'complete', reasons: [],
      missingDimensions: [], range: { startMs: 100, endMs: 200, complete: true }, ranked: [],
      sources: [{ source: 'runtime', path: 'runtime', status: 'available', machineId: 'machine', eventCount: 1 }] } });
    const parse = vi.spyOn(UsageAnalyticsSourceCoverageSchema.shape.source._zod, 'run');
    try {
      const first = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }],
        sourceLocations: [{ machineId: 'machine', displayLocation: 'Current machine' }] });
      const second = resolveUsagePageAggregation({ queries: [query], previous: first,
        accounting: [{ query, value: first.results[0]!.accounting, status: 'available' }] });
      expect(first.results[0]!.accounting!.coverage!.sources[0]).toHaveProperty('displayLocation', 'Current machine');
      expect(second.results[0]!.accounting!.coverage!.sources[0]).not.toHaveProperty('displayLocation');
      expect(parse.mock.calls.length, 'source-label refresh is not external admission').toBe(0);
      expect(UsageQueryBatchResultSchema.safeParse(second).success).toBe(true);
    } finally { parse.mockRestore(); }
  });
  it('reconciles changed accounting fields once and retains its unchanged contribution population', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeSessionEvidence: false, includeWorkEvidence: false });
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, contributions: Array.from({ length: 100 }, (_, index) => ({
      id: String(index), observedAtMs: 150, sessionId: null, turnId: null, agentId: null, modelId: null,
      machineId: null, projectKey: null, workspaceId: null, source: null, tokens, cost: accounting.totals.cost,
    })) });
    // Keep the changed member after the large unchanged population, as in a
    // late coverage/insight revision. Count real data reads, not elapsed time.
    const insights = { activeDays: 1, longestStreakDays: 1, sessionsUsed: 0, messagesUsed: 0, modelsTried: 0, favoriteModelChangeCount: 0 };
    const before = { ...value, insights };
    const after = { ...structuredClone(value), insights: { ...insights, activeDays: 2 } };
    let visits = 0;
    for (const row of after.contributions!) {
      const id = row.id;
      Object.defineProperty(row, 'id', { enumerable: true, get() { visits++; return id; } });
    }
    const previous = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: before, status: 'available' }] });
    expect(retainUsageQueryResultReferences({ ...previous, results: [...previous.results] }, previous)).toBe(previous);
    const current = { ...previous, results: previous.results.map(slice => ({ ...slice, accounting: after })) };
    const result = retainUsageQueryResultReferences(current, previous);
    expect(result.results[0]!.accounting!.insights!.activeDays).toBe(2);
    expect(result.results[0]!.accounting!.contributions).toBe(previous.results[0]!.accounting!.contributions);
    expect(visits).toBeLessThanOrEqual(after.contributions!.length);
  });
  it('reuses snapshot pricing only for the same response, tariffs and cost basis', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, contributions: [{ id: 'one', observedAtMs: 150,
      sessionId: null, turnId: null, agentId: null, modelId: 'model', machineId: null, projectKey: null, workspaceId: null, source: null,
      tokens, cost: accounting.totals.cost }] });
    const overrides = { model: { kind: 'rates' as const, inputUsdPerMillion: 2, outputUsdPerMillion: 1 } };
    const projected = projectUsageAccountingSnapshotPrices({ query, value, status: 'available' }, overrides);
    expect(projectUsageAccountingSnapshotPrices(projected, structuredClone(overrides))).toBe(projected);
    const sibling = projectUsageAccountingSnapshotPrices({ query: normalizeUsageQuery({ ...query,
      includeTranscriptEvidence: !query.includeTranscriptEvidence }), value, status: 'available' }, structuredClone(overrides), [projected]);
    expect(sibling.priceProjection).toBe(projected.priceProjection);
    expect(projected.priceProjection?.value.totals.cost.apiEquivalentUsd).toBeCloseTo(28 / 1_000_000);
    const repriced = projectUsageAccountingSnapshotPrices(projected, { model: { ...overrides.model, inputUsdPerMillion: 3 } }, [projected]);
    expect(repriced.priceProjection?.value.totals.cost.apiEquivalentUsd).toBeCloseTo(40 / 1_000_000);
    const replaced = projectUsageAccountingSnapshotPrices({ ...projected, value: { ...value,
      contributions: value.contributions!.map(row => ({ ...row, tokens: { ...tokens, input: 24, total: 28 } })) } }, overrides, [projected]);
    expect(replaced.priceProjection?.value.totals.cost.apiEquivalentUsd).toBeCloseTo(52 / 1_000_000);
    const selected = projectUsageAccountingSnapshotPrices({ ...projected, query: normalizeUsageQuery({ ...query, costBasis: 'api_equivalent' }) }, overrides, [projected]);
    expect(selected.priceProjection?.value.costPresentation?.mode).toBe('api_equivalent');
    expect(projectUsageAccountingSnapshotPrices(projected, undefined).priceProjection).toBeUndefined();
    expect(projectUsageAccountingSnapshotPrices({ ...projected, value: undefined }, overrides).priceProjection).toBeUndefined();
    expect(projected.value).toBe(value);
    expect(projected.priceProjection?.value.totals.cost.reportedUsd).toBe(value.totals.cost.reportedUsd);
  });
  it('keeps quota-only slices free of accounting and private evidence in a mixed batch', () => {
    const full = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const quota = normalizeUsageQuery({ ...full, includeAccounting: false });
    expect(resolveUsagePageAccountingRequests([quota])).toEqual([]);
    expect(resolveUsagePageAccountingRequests([full, quota])).toEqual(resolveUsagePageAccountingRequests([full]));
    const batch = resolveUsagePageAggregation({ queries: [full, quota], quota: { status: 'unsupported' },
      accounting: [full, quota].map(query => ({ query, value: accounting, status: 'available' })),
      sources: [{ source: 'how_you_work', status: 'pending' }],
    });
    expect(batch.results[0]!.accounting).toBeDefined();
    expect(batch.results[1]).toMatchObject({ requestedQuery: quota, shownQuery: quota, pending: false });
    for (const field of ['accounting', 'comparison', 'work', 'howYouWork', 'coach', 'costFactTotals']) expect(batch.results[1]).not.toHaveProperty(field);
    expect(UsageQueryBatchResultSchema.safeParse(batch).success).toBe(true);
    expect(UsageQueryBatchResultSchema.safeParse({ ...batch, results: [{ ...batch.results[1], accounting }] }).success).toBe(false);
    const refreshed = resolveUsagePageAggregation({ queries: [quota], previous: batch, quota: { status: 'unsupported' } });
    expect(refreshed.results[0]).toBe(batch.results[1]);
  });
  it('projects Work allocations only for the slice that requested Work evidence', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, includeWorkEvidence: false });
    const workQuery = normalizeUsageQuery({ ...query, includeWorkEvidence: true });
    const contribution = { id: 'one', observedAtMs: 150, sessionId: 'session', turnId: null, agentId: null,
      modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null,
      tokens, cost: accounting.totals.cost };
    const observed = { ...accounting, contributions: [contribution] };
    const batch = resolveUsagePageAggregation({ queries: [query, workQuery], accounting: [query, workQuery].map(query => ({
      query, status: 'available' as const, value: observed,
    })) });
    expect(batch.results[0]?.accounting?.contributions).toEqual([contribution]);
    expect(batch.results[0]?.work).toBeUndefined();
    expect(batch.results[1]?.work?.allocations.map(row => row.contribution)).toEqual([contribution]);
    expect(UsageQueryBatchResultSchema.safeParse(batch).success).toBe(true);
  });
  it('does not retain an unobserved initial Coach in place of the first admitted accounting evidence', () => {
    const nowMs = Date.UTC(2026, 9, 14, 12);
    const query = normalizeUsageQuery({ period: { relative: '7days' } });
    const initial = resolveUsagePageAggregation({ queries: [query], nowMs,
      accounting: [{ query, status: 'pending' }], sources: [{ source: 'how_you_work', status: 'pending' }] });
    expect(initial.results[0]?.coach?.asOfMs).toBeNull();
    const arrived = resolveUsagePageAggregation({ queries: [query], nowMs, previous: initial,
      accounting: [{ query, status: 'available', value: accounting, asOfMs: nowMs }],
      sources: [{ source: 'how_you_work', status: 'pending' }] });
    expect(arrived.results[0]?.coach).toMatchObject({ asOfMs: nowMs, currentness: 'current' });
    expect(UsageQueryBatchResultSchema.safeParse(arrived).success).toBe(true);
  });
  it('keeps relative accounting comparisons exact while older private Coach evidence is retained during refresh', () => {
    const nowMs = Date.UTC(2026, 9, 13, 12);
    const laterMs = nowMs + 797_526;
    const query = normalizeUsageQuery({ period: { relative: '7days' } });
    const period = resolveUsageQueryPeriod(query, nowMs);
    const laterPeriod = resolveUsageQueryPeriod(query, laterMs);
    const observed = (range: typeof period) => UsageAnalyticsQueryResponseSchema.parse({ ...accounting,
      coverage: { status: 'partial', reasons: [], missingDimensions: [], ranked: [], sources: [], range: { ...range, complete: false } },
    });
    const first = resolveUsagePageAggregation({ queries: [query], nowMs,
      accounting: [{ query, period, value: observed(period), status: 'available', asOfMs: nowMs }],
      howYouWork: [{ query, asOfMs: nowMs, detail: { status: 'partial', facts: [] } }],
    });
    const refreshed = resolveUsagePageAggregation({ queries: [query], nowMs: laterMs, previous: first,
      accounting: [{ query, period: laterPeriod, value: observed(laterPeriod), status: 'available', asOfMs: laterMs }],
      sources: [{ source: 'how_you_work', status: 'pending' }],
    });
    const slice = refreshed.results[0]!;
    expect(slice.coach).toMatchObject({ period, currentness: 'stale' });
    expect(slice.accounting?.coverage?.range).toMatchObject(laterPeriod);
    expect(slice.comparison?.query).toEqual(resolveUsagePageAccountingRequests([query], laterMs)[1]);
    const parsed = UsageQueryBatchResultSchema.safeParse(refreshed);
    expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(UsageQueryBatchResultSchema.safeParse({ ...refreshed, results: [{ ...slice, comparison: {
      ...slice.comparison, query: resolveUsagePageAccountingRequests([query], nowMs)[1],
    } }] }).success).toBe(false);
    const failed = resolveUsagePageAggregation({ queries: [query], nowMs: laterMs, previous: first,
      accounting: [{ query, period: laterPeriod, status: 'error', errorCode: 'usage_query_failed' }],
      sources: [{ source: 'how_you_work', status: 'pending' }],
    });
    expect(failed.results[0]?.accounting?.coverage?.range).toMatchObject(period);
    expect(failed.results[0]?.comparison?.query).toEqual(first.results[0]?.comparison?.query);
    expect(UsageQueryBatchResultSchema.safeParse(failed).success).toBe(true);
    const unboundedCoverage = resolveUsagePageAggregation({ queries: [query], nowMs: laterMs,
      accounting: [{ query, period: laterPeriod, value: observed({ startMs: laterPeriod.startMs }),
        status: 'available', asOfMs: laterMs }],
    });
    expect(unboundedCoverage.results[0]?.coach?.period).toEqual(laterPeriod);
    expect(UsageQueryBatchResultSchema.safeParse(unboundedCoverage).success).toBe(true);
  });
  it('uses the witnessed relative range for comparison and private detail even when accounting fails', () => {
    const nowMs = Date.UTC(2026, 9, 12, 12);
    const query = normalizeUsageQuery({ period: { relative: '7days' } });
    const period = resolveUsageQueryPeriod(query, nowMs);
    const absolute = normalizeUsageQuery({ period });
    const requests = resolveUsagePageAccountingRequests([query], nowMs);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toEqual(query);
    expect(requests[1]).toEqual(resolveUsagePageAccountingRequests([absolute], nowMs)[1]);
    const input = { accounting: [{ query, status: 'error' as const }], nowMs,
      howYouWork: [{ query, asOfMs: nowMs, detail: { status: 'partial' as const, facts: [
        { workId: 'old', evidenceId: 'old', agentId: null, machineId: null, kind: 'busy' as const,
          startMs: Date.UTC(2026, 8, 1), endMs: Date.UTC(2026, 8, 1, 1) },
        { workId: 'current', evidenceId: 'current', agentId: null, machineId: null, kind: 'busy' as const,
          startMs: nowMs - 3_600_000, endMs: nowMs },
      ] } }] };
    const batch = resolveUsagePageAggregation({ ...input, queries: [query] });
    const slice = batch.results[0]!;
    expect(slice.requestedQuery).toEqual(query);
    expect(slice.shownQuery).toEqual(query);
    expect(slice.howYouWork?.intervals).toMatchObject({ period, agentTimeMs: 3_600_000 });
    expect(slice.coach?.period).toEqual(period);
    expect(slice.comparison?.query).toEqual(requests[1]);
    expect(UsageQueryBatchResultSchema.safeParse(batch).success).toBe(true);
    const absoluteSlice = resolveUsagePageAggregation({ ...input, queries: [absolute],
      accounting: [{ query: absolute, status: 'error' }],
      howYouWork: input.howYouWork.map(snapshot => ({ ...snapshot, query: absolute })),
    }).results[0]!;
    expect(slice.howYouWork).toEqual(absoluteSlice.howYouWork);
    expect(slice.comparison?.query).toEqual(absoluteSlice.comparison?.query);
    expect(UsageQueryBatchResultSchema.safeParse({ ...batch, results: [{ ...slice,
      howYouWork: { ...slice.howYouWork, intervals: { ...slice.howYouWork!.intervals, period: { startMs: 0, endMs: nowMs } } },
    }] }).success).toBe(false);
    const otherPeriod = { startMs: 2000, endMs: 3000 };
    expect(UsageQueryBatchResultSchema.safeParse({ v: 1, results: [{ ...absoluteSlice, coach: undefined, howYouWork: undefined,
      accounting: { ...accounting, coverage: { status: 'complete', reasons: [], sources: [], missingDimensions: [], ranked: [],
        range: { ...otherPeriod, complete: true } } },
      comparison: { query: normalizeUsageQuery({ ...absolute, period: { startMs: 1000, endMs: 2000 } }),
        source: { source: 'comparison', status: 'unknown' } },
    }] }).success).toBe(false);
    const all = normalizeUsageQuery({ period: { relative: 'all' } });
    expect(resolveUsagePageAccountingRequests([all], nowMs)).toEqual([all]);
    expect(resolveUsagePageAccountingRequests([normalizeUsageQuery({})], nowMs)).toHaveLength(1);
  });
  it('shares already-admitted quota history across query slices instead of reparsing each copy', () => {
    const source = { ref: { service: { pluginId: 'test.provider', localId: 'subscription' }, accountId: 'one' }, bindingKind: 'account' as const };
    const recordKey = { providerId: 'provider', accountSubjectId: 'one', subjectKind: 'account', quotaScope: 'account' } as const;
    const snapshot = { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'provider',
      accountSubject: { kind: 'providerSubject', id: 'one' }, observedAtMs: 150, fetchedAtMs: 150, staleAfterMs: 100,
      source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [] };
    // Genuine input boundary validation happens once before projection.
    const quota = ConnectedServiceQuotaGetResultV1Schema.parse({ source, current: snapshot,
      history: { entries: Array.from({ length: 1000 }, (_, index) => ({ id: `history-${index}`, observedAtMs: index, snapshot })), nextCursor: null },
      pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' } });
    const queries = Array.from({ length: 8 }, (_, index) => normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, agents: [`agent-${index}`] }));
    const start = performance.now();
    const batch = resolveUsagePageAggregation({ queries, quota: { status: 'available', value: [quota] }, nowMs: 150 });
    const ms = performance.now() - start;
    console.info('[PERF-RENDER aggregation]', JSON.stringify({ slices: queries.length, historyEntries: 1000,
      retainedQuotaReferences: batch.results.filter(slice => slice.quota?.[0] === quota).length, ms }));
    expect(batch.results.every(slice => slice.quota?.[0] === quota)).toBe(true);
    expect(UsageQueryBatchResultSchema.safeParse(batch).success).toBe(true);
    const denied = resolveUsagePageAggregation({ queries, previous: batch, quota: { status: 'error', errorCode: 'denied' } });
    expect(denied.results.every(slice => slice.quota === undefined)).toBe(true);
  });
  it('adds only authorized machine display locations and retires them when unavailable while accepting older source rows', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const coverage: NonNullable<UsageAnalyticsQueryResponse['coverage']> = { status: 'partial', reasons: [], missingDimensions: [], range: { complete: false }, ranked: [], sources: [
      { source: 'runtime', path: 'runtime', status: 'available', eventCount: 1, machineId: 'work', captureKind: 'measured' },
      { source: 'history', path: 'native', status: 'partial', eventCount: 1, machineId: 'missing', captureKind: 'from_logs' },
      { source: 'legacy', path: 'legacy', status: 'unknown', eventCount: 1 },
    ] };
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, coverage,
      breakdowns: { machine: [{ key: 'work', label: 'Work', eventCount: 1, tokens, cost: accounting.totals.cost }] },
    });
    const first = resolveUsagePageAggregation({ queries: [query], accounting: [{ query,
      value, status: 'available' }], sourceLocations: [{ machineId: 'work', displayLocation: 'Workstation' }] });
    expect(first.results[0]?.accounting?.coverage?.sources).toEqual([
      { ...coverage.sources[0], displayLocation: 'Workstation' }, coverage.sources[1], coverage.sources[2],
    ]);
    expect(UsageQueryBatchResultSchema.safeParse(first).success).toBe(true);
    // The ranked chart can omit a machine that still has admitted coverage. It
    // must remain selectable without inventing identities for older source rows.
    expect(readUsageScopeOptions(first.results, 'machines', ['selected'])).toEqual(new Map([
      ['work', 'Work'], ['missing', 'missing'], ['selected', 'selected'],
    ]));
    expect(first.results[0]?.accounting?.breakdowns?.machine).toHaveLength(1);
    const retired = resolveUsagePageAggregation({ queries: [query], previous: first,
      accounting: [{ query, status: 'error', errorCode: 'network_error' }], sourceLocations: [] });
    expect(retired.results[0]?.accounting?.coverage?.sources.every(source => !('displayLocation' in source))).toBe(true);
    expect(UsageAnalyticsQueryResponseSchema.safeParse({ ...accounting, coverage: { ...coverage,
      sources: [{ ...coverage.sources[0], displayLocation: '/private/project' }] } }).success).toBe(false);
    const denied = resolveUsagePageAggregation({ queries: [query], previous: first,
      accounting: [{ query, status: 'error', errorCode: 'permission_denied' }] });
    expect(readUsageScopeOptions(denied.results, 'machines', ['selected'])).toEqual(new Map([['selected', 'selected']]));
  });
  it('reprojects chosen night hours while retaining the exact query private interval evidence during a reread', () => {
    const hour = 3_600_000;
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 24 * hour } });
    const value = { ...accounting, activity: { weekdayHourBuckets: [
      { weekday: 4, hour: 0, eventCount: 7 }, { weekday: 4, hour: 12, eventCount: 3 },
    ] } };
    const source = { query, value, status: 'available' as const };
    const first = resolveUsagePageAggregation({ queries: [query], accounting: [source],
      nightHours: { startHour: 22, endHour: 6 }, howYouWork: [{ query, detail: { status: 'partial',
        facts: [{ workId: 'w', evidenceId: 'e', agentId: null, machineId: null, kind: 'busy', startMs: 0, endMs: hour }],
        acceptedInputs: [], permissions: [] } }] });
    const revised = resolveUsagePageAggregation({ queries: [query], accounting: [source], previous: first,
      nightHours: { startHour: 9, endHour: 17 }, sources: [{ source: 'how_you_work', status: 'pending' }] });
    expect(revised.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial',
      intervals: { agentTimeMs: hour, night: { startHour: 9, endHour: 17, busyMs: 0, activityCount: 3 } },
      nightShift: { startHour: 9, endHour: 17, recordedActivityCount: 3, observedBusyMs: 0 } });
    const cleared = resolveUsagePageAggregation({ queries: [query], accounting: [source], previous: revised,
      nightHours: null, sources: [{ source: 'how_you_work', status: 'pending' }] });
    expect(cleared.results[0]?.howYouWork?.nightShift).toBeNull();
    expect(cleared.results[0]?.howYouWork?.intervals?.night).toBeNull();
    const refused = resolveUsagePageAggregation({ queries: [query], accounting: [source], previous: revised,
      nightHours: { startHour: 9, endHour: 17 }, howYouWork: [{ query, detail: { status: 'unknown' } }] });
    expect(refused.results[0]?.howYouWork).toMatchObject({ detailStatus: 'unknown', intervals: null,
      nightShift: { recordedActivityCount: 3, observedBusyMs: null } });
  });

  it('attributes observed API-equivalent value to the exact connected account and qualifies price multiples by period and currency', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const service = { pluginId: 'test.provider', localId: 'subscription' };
    const source = { ref: { service, accountId: 'one' }, bindingKind: 'account' as const };
    const recordKey = { providerId: 'provider', accountSubjectId: 'one', subjectKind: 'account', quotaScope: 'account' } as const;
    const read = ConnectedServiceQuotaGetResultV1Schema.parse({ source, current: {
      v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey, providerId: 'provider',
      accountSubject: { kind: 'providerSubject', id: 'one' }, observedAtMs: 150, fetchedAtMs: 150, staleAfterMs: 100,
      source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [], subscription: {
        status: 'subscribed', renewal: 'on', observedAtMs: 150, staleAfterMs: 100,
        currentPeriodStartAtMs: 100, currentPeriodEndAtMs: 200,
        enteredMonthlyPrice: { amount: 2, currency: 'USD', enteredAtMs: 100 },
      },
    }, pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' } });
    const contribution = { id: 'one', eventCount: 1, observedAtMs: 140, sessionId: 's', turnId: 't', agentId: 'agent',
      modelId: 'model', machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens,
      cost: { reportedUsd: 20, estimatedUsd: 8, apiEquivalentUsd: 4, pricingSource: 'user:override:model', currency: 'USD' },
      providerAttribution: 'known' as const, connectedAccount: source.ref };
    const value: UsageAnalyticsQueryResponse = { ...accounting, contributions: [contribution,
      { ...contribution, id: 'switched', connectedAccount: { ...source.ref, accountId: 'two' }, cost: { ...contribution.cost, apiEquivalentUsd: 60 } },
      { ...contribution, id: 'different-service', connectedAccount: { ...source.ref, service: { ...service, localId: 'another' } } },
      { ...contribution, id: 'unknown', providerAttribution: 'unknown' as const },
    ] };
    const project = (quota = read, supplied = value, selectedQuery = query) => projectUsagePlanInsights({ query: selectedQuery,
      nowMs: 150, accounting: supplied, quota: [quota] }).accounts[0]!.value;
    expect(project()).toMatchObject({ status: 'available', kind: 'api_equivalent', amountUsd: 4, currency: 'USD',
      period: { startMs: 100, endMs: 200 }, coverage: 'partial', pricedContributionCount: 1, unknownAccountContributionCount: 1,
      pricingSources: ['user:override:model'], priceMultiple: { status: 'available', multiple: 2, priceKind: 'entered',
        priceAmount: 2, currency: 'USD', period: { startAtMs: 100, endAtMs: 200 } } });
    const relative = normalizeUsageQuery({ period: { relative: '7days' } });
    const endMs = Date.parse('2026-10-11T20:30:00Z');
    const period = { startMs: endMs - 7 * 86_400_000, endMs };
    const relativeResult = resolveUsagePageAggregation({ queries: [relative], quota: { status: 'available', value: [read] }, accounting: [{ query: relative,
      status: 'available', value: { ...value, coverage: { status: 'partial', reasons: [], missingDimensions: [],
        range: { ...period, complete: false }, ranked: [], sources: [] } } }] });
    expect(relativeResult.results[0]).toMatchObject({ shownQuery: relative,
      planInsights: { accounts: [{ value: { status: 'available', amountUsd: 4, period } }] }, coach: { period } });
    expect(project({ ...read, current: { ...read.current!, subscription: { ...read.current!.subscription!,
      enteredMonthlyPrice: { amount: 2, currency: 'EUR', enteredAtMs: 100 } } } })).toMatchObject({ amountUsd: 4,
        priceMultiple: { status: 'insufficient_basis', reason: 'currency_mismatch' } });
    expect(project(read, value, normalizeUsageQuery({ period: { startMs: 90, endMs: 200 } }))).toMatchObject({
      priceMultiple: { status: 'insufficient_basis', reason: 'period_mismatch' } });
    expect(project(read, { ...value, contributions: [{ ...contribution, cost: { reportedUsd: 20, estimatedUsd: 8, currency: 'USD' } }] }))
      .toMatchObject({ status: 'insufficient_basis', reason: 'account_usage_unpriced' });
    expect(project(read, { ...value, contributions: [{ ...contribution, providerAttribution: 'unknown' as const }] }))
      .toMatchObject({ status: 'insufficient_basis', reason: 'account_attribution_unavailable' });
    const unpriced = { ...contribution, id: 'unpriced', cost: { reportedUsd: 20, estimatedUsd: 8, currency: 'USD' } };
    expect(project(read, { ...value, contributions: [contribution, unpriced] })).toMatchObject({ status: 'available',
      amountUsd: 4, coverage: 'partial', pricedContributionCount: 1, unpricedContributionCount: 1 });
    expect(project({ ...read, current: { ...read.current!, subscription: { ...read.current!.subscription!,
      enteredMonthlyPrice: { amount: 0, currency: 'USD', enteredAtMs: 100 } } } })).toMatchObject({
      priceMultiple: { status: 'insufficient_basis', reason: 'zero_price' } });
    const complete = UsageAnalyticsQueryResponseSchema.parse({ ...value, contributions: [contribution,
      { ...contribution, id: 'native-without-account', providerSource: 'native', connectedAccount: null },
      { ...contribution, id: 'api', providerSource: 'provider', providerConnectionId: 'api-connection', connectedAccount: null }],
      coverage: { status: 'complete', reasons: [], sources: [], missingDimensions: [], range: { complete: true }, ranked: [] } });
    expect(project(read, complete)).toMatchObject({ amountUsd: 4, coverage: 'complete', unknownAccountContributionCount: 0 });
    const missingAccount = UsageAnalyticsQueryResponseSchema.parse({ ...complete, contributions: [contribution,
      { ...contribution, id: 'missing-native-account', providerSource: 'native', connectedAccount: undefined }] });
    expect(project(read, missingAccount)).toMatchObject({ amountUsd: 4, coverage: 'partial', unknownAccountContributionCount: 1 });
  });
  it('projects window weather and model-specific headroom without ranking unrelated models or inventing account value', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const recordKey = { providerId: 'provider', accountSubjectId: 'one', subjectKind: 'account', quotaScope: 'account' } as const;
    const recordId = buildProviderAccountUsageRecordId(recordKey);
    const quota = ConnectedServiceQuotaGetResultV1Schema.parse({
      source: { ref: { service: { pluginId: 'test.provider', localId: 'subscription' }, accountId: 'one' }, bindingKind: 'account' },
      current: { v: 1, recordId, recordKey, providerId: 'provider', accountSubject: { kind: 'providerSubject', id: 'one' },
        observedAtMs: 150, fetchedAtMs: 150, staleAfterMs: 100, source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data',
        meters: [{ meterId: 'model', label: 'Model allowance', modelId: 'witnessed-model', used: 25, limit: 100, utilizationPct: 25, unit: 'requests', status: 'ok', resetsAt: 200, resetAtMs: 200, windowDurationMs: 100 }] },
      pace: [{ meterId: 'model', value: { status: 'available', window: { recordId, meterId: 'model', resetAtMs: 200, windowStartAtMs: 100, windowDurationMs: 100 },
        usedFraction: 0.25, elapsedFraction: 0.5, evenPaceFraction: 0.5, pace: 0.5, projectedResetUtilizationFraction: 0.5, qualification: 'confirmed', sampleCount: 1 } }],
      targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
    });
    const slice = resolveUsagePageAggregation({ queries: [query], nowMs: 150, quota: { status: 'available', value: [quota] } }).results[0]!;
    expect(slice).toMatchObject({ planInsights: { accounts: [{
      value: { status: 'insufficient_basis', reason: 'account_attribution_unavailable' },
      weather: [{ meterId: 'model', status: 'available', outlook: 'within_even_pace', projectedUsedFraction: 0.5, sampleCount: 1, method: 'witnessed_linear_pace' }],
      modelHeadroom: [{ meterId: 'model', modelId: 'witnessed-model', status: 'available', remainingFraction: 0.75, method: 'model_specific_quota_meter' }],
    }] } });
    const stale = resolveUsagePageAggregation({ queries: [query], nowMs: 250, quota: { status: 'available', value: [quota] } }).results[0]!;
    expect(stale).toMatchObject({ planInsights: { accounts: [{ weather: [{ status: 'insufficient_basis', reason: 'stale' }],
      modelHeadroom: [{ status: 'insufficient_basis', reason: 'stale' }] }] } });
    const justStarted = ConnectedServiceQuotaGetResultV1Schema.parse({ ...quota,
      current: { ...quota.current!, meters: [{ ...quota.current!.meters[0]!, resetAtMs: 250, resetsAt: 250 }] },
      pace: [{ meterId: 'model', value: { status: 'unavailable', reason: 'zero_elapsed' } }],
    });
    expect.soft(resolveUsagePageAggregation({ queries: [query], nowMs: 150, quota: { status: 'available', value: [justStarted] } }).results[0])
      .toMatchObject({ planInsights: { accounts: [{ modelHeadroom: [{ status: 'available', modelId: 'witnessed-model', remainingFraction: 0.75 }] }] } });
    const meter = { ...quota.current!.meters[0]!, resetAtMs: 180, resetsAt: 180, windowDurationMs: 40 };
    const subscription = { status: 'subscribed', renewal: 'on', observedAtMs: 150, staleAfterMs: 100,
      currentPeriodStartAtMs: 100, currentPeriodEndAtMs: 200, enteredMonthlyPrice: { amount: 20, currency: 'EUR', enteredAtMs: 100 } };
    const ended = { ...quota.current!, observedAtMs: 138, fetchedAtMs: 138, subscription, meters: [{ ...meter, resetAtMs: 140, resetsAt: 140 }] };
    const resetRead = ConnectedServiceQuotaGetResultV1Schema.parse({ ...quota, current: { ...quota.current!, meters: [meter],
      subscription },
      history: { entries: [{ id: 'one', observedAtMs: 138, snapshot: ended }, { id: 'duplicate', observedAtMs: 138, snapshot: ended }], nextCursor: null },
    });
    expect.soft(resolveUsagePageAggregation({ queries: [query], nowMs: 150, quota: { status: 'available', value: [resetRead] } }).results[0])
      .toMatchObject({ planInsights: { accounts: [{ pricePerReset: [{ status: 'available', amount: 20, currency: 'EUR', priceKind: 'entered',
        recordedResetCount: 1, coverage: 'recorded_subset', method: 'period_price_divided_by_recorded_resets' }] }] } });
    const invalidRead = { ...resetRead, history: { entries: [{ id: 'not-recorded', observedAtMs: 150,
      snapshot: { ...ended, observedAtMs: 150, state: 'not_loaded' as const, meters: [{ ...meter, resetAtMs: 150, resetsAt: 150 }] } }], nextCursor: null } };
    expect.soft(resolveUsagePageAggregation({ queries: [query], nowMs: 150, quota: { status: 'available', value: [invalidRead] } }).results[0])
      .toMatchObject({ planInsights: { accounts: [{ pricePerReset: [{ status: 'insufficient_basis', reason: 'recorded_resets_unavailable' }] }] } });
    expect.soft(UsageQueryBatchResultSchema.safeParse({ v: 1, results: [{ ...slice, quota: undefined }] }).success).toBe(false);
  });
  it('reports an ended recorded week with explicit partial coverage, never a perfection score or assumed human presence', () => {
    const startMs = Date.UTC(2026, 9, 5);
    const endMs = Date.UTC(2026, 9, 12);
    const query = normalizeUsageQuery({ period: { startMs, endMs } });
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, activity: {
      calendarDays: [{ date: '2026-10-05', eventCount: 1 }, { date: '2026-10-07', eventCount: 2 }],
      weekdayHourBuckets: [],
    } });
    const slice = resolveUsagePageAggregation({ queries: [query], nowMs: endMs, accounting: [{ query, value, status: 'available' }] }).results[0]!;
    expect(slice).toMatchObject({ planInsights: { recordedWeek: { status: 'available', startMs, endMs,
      recordedActiveDays: 2, recordedEvents: 3, coverage: 'partial', method: 'recorded_calendar_week', humanPresence: 'unknown' } } });
    expect(slice).not.toHaveProperty('planInsights.recordedWeek.score');
    expect.soft(UsageQueryBatchResultSchema.safeParse({ v: 1, results: [{ ...slice,
      planInsights: { ...slice.planInsights, recordedWeek: { ...slice.planInsights!.recordedWeek, endMs: endMs + 1 } } }] }).success).toBe(false);
    const completeAccounting = UsageAnalyticsQueryResponseSchema.parse({ ...value,
      coverage: { status: 'complete', reasons: [], sources: [], missingDimensions: [], range: { complete: true }, ranked: [] } });
    expect(resolveUsagePageAggregation({ queries: [query], nowMs: endMs, accounting: [{ query, value: completeAccounting, status: 'available' }] }).results[0])
      .toMatchObject({ planInsights: { recordedWeek: { coverage: 'partial', accountingCoverage: 'complete', intervalCoverage: 'unknown' } } });
    expect(resolveUsagePageAggregation({ queries: [query], nowMs: endMs - 1, accounting: [{ query, value, status: 'available' }] }).results[0])
      .toMatchObject({ planInsights: { recordedWeek: { status: 'insufficient_basis', reason: 'week_not_ended' } } });
  });
  it('re-prices historical API-equivalent facts through Account overrides without changing vendor reports', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const historicalTokens = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 1_000_000 };
    const cost = { reportedUsd: 4, estimatedUsd: 1.75, currency: 'USD', costSource: 'provider_reported' };
    const value = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1, tokens: historicalTokens, cost },
      contributions: [{ id: 'history', observedAtMs: 150, sessionId: 's', turnId: 't', agentId: 'codex', modelId: 'gpt-5.2',
        machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens: historicalTokens, tokenCategories: historicalTokens, cost }],
      costFacts: [{ kind: 'reported', amountUsd: 4, currency: 'USD', source: 'provider_reported', tokens: historicalTokens,
        eventCount: 1, asOfMs: 150, complete: false }],
    });
    const result = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }],
      pricingOverrides: { 'gpt-5.2': { kind: 'rates', inputUsdPerMillion: 9, outputUsdPerMillion: 1 } },
    });
    expect(result.results[0]!.costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(9);
    expect(result.results[0]!.accounting!.totals.cost.reportedUsd).toBe(4);
    expect(result.results[0]!.accounting!.contributions![0]!.cost.estimatedUsd).toBe(1.75);
    expect(result.results[0]!.costFactTotals?.find(fact => fact.kind === 'reported')?.amountUsd).toBe(4);
    const retained = resolveUsagePageAggregation({ queries: [query], previous: result,
      accounting: [{ query, status: 'error', errorCode: 'network_error' }],
      pricingOverrides: { 'gpt-5.2': { kind: 'rates', inputUsdPerMillion: 13, outputUsdPerMillion: 1 } } });
    expect(retained.results[0]!.costFactTotals?.find(fact => fact.kind === 'api_equivalent')?.amountUsd).toBe(13);
  });
  it('offers a query-bound recurring digest recipe without choosing or creating its Automation', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, machines: ['selected-machine'], costBasis: 'reported' });
    const result = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: accounting, status: 'available', asOfMs: 200 }] });
    const coach = result.results[0]!.coach!;
    expect(coach).toHaveProperty('digestSuggestion', {
      kind: 'recurring_automation', queryKey: result.results[0]!.key, lookbackMs: 100,
      query, actionId: 'workflow.trigger.add', requiredInputs: ['project', 'trigger'],
      target: { kind: 'inline', definition: expect.objectContaining({
        blocks: expect.arrayContaining([
          expect.objectContaining({ kind: 'step', id: 'digest' }),
          expect.objectContaining({ kind: 'action', actionId: 'notifications.notify_me' }),
        ]),
      }) },
    });
    expect(coach.digestSuggestion).not.toHaveProperty('project');
    expect(coach.digestSuggestion).not.toHaveProperty('trigger');
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
    const emptyPeriod = normalizeUsageQuery({ ...query, period: { startMs: 100, endMs: 100 } });
    expect(resolveUsagePageAggregation({ queries: [emptyPeriod] }).results[0]!.coach).not.toHaveProperty('digestSuggestion');
  });
  it('keeps conservative witnessed accounting freshness and never substitutes an unavailable source or the clock', () => {
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, coverage: { status: 'partial', reasons: [],
      sources: [{ source: 'a', path: 'native', status: 'available', asOfMs: 180, eventCount: 1 },
        { source: 'b', path: 'runtime', status: 'partial', asOfMs: 160, eventCount: 1 },
        { source: 'c', path: 'unknown', status: 'unsupported', asOfMs: 1, eventCount: 0 }],
      missingDimensions: [], range: { complete: false }, ranked: [] } });
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }] }).results[0]!;
    expect(slice.coach).toMatchObject({ asOfMs: 160, currentness: 'current' });
    expect(slice.sources.find(row => row.source === 'accounting')?.asOfMs).toBe(160);
    const unknown = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: accounting, status: 'available' }] }).results[0]!;
    expect(unknown.coach).toMatchObject({ asOfMs: null, currentness: 'unknown' });
  });
  it('totals each monetary kind and denomination with all contributing source provenance', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const fact = { kind: 'reported' as const, currency: 'USD', amountUsd: 2, tokens, eventCount: 1, asOfMs: 180, complete: true };
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, costFacts: [
      { ...fact, source: 'native:a' }, { ...fact, source: 'runtime:b', amountUsd: 3, asOfMs: 150, complete: false },
      { ...fact, source: 'native:a', currency: 'EUR', amountUsd: 4 },
      { ...fact, source: 'invoice', kind: 'invoice', amountUsd: 10 },
      { ...fact, source: 'unknown', kind: 'unpriced', amountUsd: null },
    ] });
    const result = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }] });
    expect(result.results[0]).toHaveProperty('costFactTotals', [
      { ...fact, amountUsd: 5, tokens: { input: 24, output: 8, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 32 }, eventCount: 2, asOfMs: 150, complete: false, sources: ['native:a', 'runtime:b'] },
      { ...fact, currency: 'EUR', amountUsd: 4, sources: ['native:a'] },
      { ...fact, kind: 'invoice', amountUsd: 10, sources: ['invoice'] },
      { ...fact, kind: 'unpriced', amountUsd: null, sources: ['unknown'] },
    ]);
    const slice = result.results[0]!;
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...slice, accounting: undefined }] }).success).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...slice,
      costFactTotals: slice.costFactTotals?.map(total => ({ ...total, sources: ['fictional'] })),
    }] }).success).toBe(false);
  });
  it('carries overlapping qualified pools separately from unique quota accounting and withdraws denied selector evidence', () => {
    const query = normalizeUsageQuery({ machines: ['selected-machine'] });
    const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
    const selected = { profileId: 'work', priority: 1, createdAtMs: 1, enabled: true, leastLimitedScore: 80 };
    const group = { service, groupId: 'primary' };
    const value = { group, observedAtMs: 100, selection: { selected, reason: 'selected' as const, excluded: [],
      decisionTrace: { activeProfileId: 'work', reason: 'selected' as const, strategy: 'priority' as const,
        selectionBasis: 'active_stickiness' as const, sticky: true, orderedEligibleCandidates: [selected], candidates: [] } } };
    const pools = [
      { group, memberAccountIds: ['work', 'personal'], activeAccountId: 'work',
        selection: { status: 'available' as const, machineId: 'selected-machine', value, asOfMs: 100 } },
      { group: { service, groupId: 'secondary' }, memberAccountIds: ['work'], activeAccountId: null,
        selection: { status: 'error' as const, errorCode: 'permission_denied', value } },
    ];
    const result = resolveUsagePageAggregation({ queries: [query], pools: [{ query, value: pools }] });
    expect(result.results[0]).toMatchObject({ pools: [pools[0], {
      group: pools[1]!.group, memberAccountIds: ['work'], activeAccountId: null,
      selection: { status: 'error', errorCode: 'permission_denied' },
    }] });
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0], pools: [pools[1]] }] }).success).toBe(false);
  });
  it('retains exact admitted pool decisions through repeated failed reads and replaces them on recovery', () => {
    const query = normalizeUsageQuery({ includeAccounting: false, machines: ['machine'] });
    const group = { service: { pluginId: 'test.provider', localId: 'account' }, groupId: 'pool' };
    const selected = { profileId: 'work', priority: 1, createdAtMs: 1, enabled: true, leastLimitedScore: 80 };
    const value = { group, observedAtMs: 100, selection: { selected, reason: 'selected' as const, excluded: [],
      decisionTrace: { activeProfileId: 'work', reason: 'selected' as const, strategy: 'priority' as const,
        selectionBasis: 'active_stickiness' as const, sticky: true, orderedEligibleCandidates: [selected], candidates: [] } } };
    const pool = { group, memberAccountIds: ['work'], activeAccountId: 'work',
      selection: { status: 'available' as const, machineId: 'machine', value, asOfMs: 100 } };
    const quota = { status: 'unsupported' as const };
    const first = resolveUsagePageAggregation({ queries: [query], quota, pools: [{ query, value: [pool] }] });
    let previous = first;
    for (const errorCode of ['MACHINE_RPC_TIMEOUT', 'connected_service_request_failed']) {
      previous = resolveUsagePageAggregation({ queries: [query], previous, quota, pools: [{ query, value: [{ ...pool,
        selection: { status: 'error', machineId: 'machine', errorCode } }] }] });
      expect(previous.results[0]?.pools?.[0]?.selection).toEqual({ status: 'stale', machineId: 'machine', value, asOfMs: 100, errorCode });
      expect(previous.results[0]?.sources).toContainEqual({ source: 'selection:test.provider/account:pool', status: 'stale', asOfMs: 100, errorCode });
      expect(previous.results[0]?.pending).toBe(false);
      expect(UsageQueryBatchResultSchema.safeParse(previous).success).toBe(true);
    }
    for (const errorCode of ['denied', 'permission_denied', 'unauthorized', 'forbidden', 'stale_surface', 'cancelled']) {
      const refused = resolveUsagePageAggregation({ queries: [query], previous, quota, pools: [{ query, value: [{ ...pool,
        selection: { status: 'error', machineId: 'machine', errorCode } }] }] });
      expect(refused.results[0]?.pools?.[0]?.selection.value).toBeUndefined();
      const failedAfterRefusal = resolveUsagePageAggregation({ queries: [query], previous: refused, quota, pools: [{ query, value: [{ ...pool,
        selection: { status: 'error', machineId: 'machine', errorCode: 'MACHINE_RPC_TIMEOUT' } }] }] });
      expect(failedAfterRefusal.results[0]?.pools?.[0]?.selection.value).toBeUndefined();
    }
    const offline = resolveUsagePageAggregation({ queries: [query], previous, quota, pools: [{ query, value: [{ ...pool,
      selection: { status: 'unsupported', errorCode: 'no_machine' } }] }] });
    expect(offline.results[0]?.pools?.[0]?.selection).toMatchObject({ status: 'stale', machineId: 'machine', value, asOfMs: 100, errorCode: 'no_machine' });
    const changedMachine = resolveUsagePageAggregation({ queries: [query], previous, quota, pools: [{ query, value: [{ ...pool,
      selection: { status: 'error', machineId: 'other', errorCode: 'MACHINE_RPC_TIMEOUT' } }] }] });
    expect(changedMachine.results[0]?.pools?.[0]?.selection.value).toBeUndefined();
    const changedMembership = resolveUsagePageAggregation({ queries: [query], previous, quota, pools: [{ query, value: [{ ...pool,
      memberAccountIds: ['personal'], selection: { status: 'error', machineId: 'machine', errorCode: 'MACHINE_RPC_TIMEOUT' } }] }] });
    expect(changedMembership.results[0]?.pools?.[0]?.selection.value).toBeUndefined();
    const recovered = resolveUsagePageAggregation({ queries: [query], previous, quota, pools: [{ query, value: [{ ...pool,
      selection: { ...pool.selection, value: { ...value, observedAtMs: 200 }, asOfMs: 200 } }] }] });
    expect(recovered.results[0]?.pools?.[0]?.selection).toEqual({ ...pool.selection, value: { ...value, observedAtMs: 200 }, asOfMs: 200 });
    expect(resolveUsagePageAggregation({ queries: [query], previous, quota, pools: [{ query, value: [] }] }).results[0]?.pools).toEqual([]);
  });
  it('publishes all Coach evidence states on the same admitted query rather than a separate detector read', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const result = resolveUsagePageAggregation({ queries: [query],
      accounting: [{ query, value: accounting, status: 'available', asOfMs: 200 }] });
    expect(result).toMatchObject({ results: [{ coach: {
      period: { startMs: 100, endMs: 200 },
      evaluations: expect.arrayContaining([
        expect.objectContaining({ detectorId: 'duplicated_instructions', status: 'insufficient_evidence' }),
        expect.objectContaining({ detectorId: 'cache_busting_prompt_changes', status: 'insufficient_evidence' }),
      ]),
    } }] });
    const unavailable = resolveUsagePageAggregation({ queries: [query] });
    expect(unavailable.results[0]?.coach).toMatchObject({ asOfMs: null, currentness: 'unknown', findings: [] });
    expect(unavailable.results[0]?.coach?.evaluations).toHaveLength(USAGE_COACH_DETECTOR_IDS.length);
  });
  it('uses witnessed private approval pairs only on their admitted Coach query', () => {
    const query = normalizeUsageQuery({ session: 'session', period: { startMs: 100, endMs: 200 } });
    const other = normalizeUsageQuery({ ...query, session: 'other' });
    const detail = { status: 'partial' as const, facts: [], acceptedInputs: [], permissions: [{
      requestId: 'request', workId: JSON.stringify(['session', 'turn']), requestedAtMs: 120,
      decidedAtMs: 160, toolId: 'Bash', answeringClientCategory: null,
    }] };
    const result = resolveUsagePageAggregation({ queries: [query, other], howYouWork: [{ query, detail, asOfMs: 200 }] });
    expect(result.results[0]).toHaveProperty('coach.findings', expect.arrayContaining([
      expect.objectContaining({ detectorId: 'approval_friction', coverage: 'partial',
        measurements: expect.arrayContaining([{ metric: 'permission_wait', value: 40, unit: 'milliseconds' }]) }),
    ]));
    expect(result.results[1]).toHaveProperty('coach.findings', []);
    const pending = resolveUsagePageAggregation({ queries: [query, other], previous: result,
      sources: [{ source: 'how_you_work', status: 'pending' }],
      accounting: [{ query, value: accounting, status: 'available', asOfMs: 210 }] });
    expect(pending.results[0]?.coach).toMatchObject({ currentness: 'stale', findings: [
      expect.objectContaining({ detectorId: 'approval_friction', currentness: 'stale', remedy: null, action: null }),
    ] });
    expect(pending.results[1]).toHaveProperty('coach.findings', []);
    expect(UsageQueryBatchResultSchema.safeParse(pending).success).toBe(true);
    const failed = resolveUsagePageAggregation({ queries: [query, other], previous: result,
      howYouWork: [{ query, errorCode: 'usage_session_evidence_read_failed' }] });
    expect(failed.results[0]?.sources).toContainEqual({ source: 'how_you_work', status: 'stale', asOfMs: 200, errorCode: 'usage_session_evidence_read_failed' });
    expect(failed.results[0]?.coach?.findings[0]?.evidenceKey).toBe(result.results[0]?.coach?.findings[0]?.evidenceKey);
    expect(failed.results[0]?.coach?.findings[0]).toMatchObject({ currentness: 'stale', remedy: null, action: null });
    expect(failed.results[1]).toHaveProperty('coach.findings', []);
    expect(UsageQueryBatchResultSchema.safeParse(failed).success).toBe(true);
    for (const errorCode of ['denied', 'permission_denied', 'unauthorized', 'forbidden', 'stale_surface', 'cancelled']) {
      const refused = resolveUsagePageAggregation({ queries: [query], previous: result, howYouWork: [{ query, errorCode }] });
      expect(refused.results[0]).toHaveProperty('coach.findings', []);
      expect(refused.results[0]?.howYouWork?.intervals).toBeNull();
      expect(UsageQueryBatchResultSchema.safeParse(refused).success).toBe(true);
    }
    const refusedBeforeFailure = resolveUsagePageAggregation({ queries: [query], previous: result,
      howYouWork: [{ query, detail: { status: 'unknown' }, errorCode: 'usage_session_evidence_read_failed' }] });
    expect(refusedBeforeFailure.results[0]).toHaveProperty('coach.findings', []);
    expect(UsageQueryBatchResultSchema.safeParse(refusedBeforeFailure).success).toBe(true);
    const denied = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query,
      detail: { ...detail, status: 'unknown' }, asOfMs: 200 }], previous: result });
    expect(denied.results[0]).toHaveProperty('coach.findings', []);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0],
      sources: [{ source: 'how_you_work', status: 'unknown' }] }] }).success).toBe(false);
  });
  it('retains an open-query finding identity when only its observation clock advances', () => {
    const query = normalizeUsageQuery({ session: 'session', period: { startMs: 100 } });
    const detail = { status: 'partial' as const, facts: [], acceptedInputs: [], permissions: [{
      requestId: 'request', workId: JSON.stringify(['session', 'turn']), requestedAtMs: 120,
      decidedAtMs: 160, toolId: 'Bash', answeringClientCategory: null,
    }] };
    const read = (asOfMs: number, decidedAtMs = 160) => resolveUsagePageAggregation({ queries: [query],
      howYouWork: [{ query, detail: { ...detail, permissions: [{ ...detail.permissions[0]!, decidedAtMs }] }, asOfMs }] });
    const first = read(200).results[0]!.coach!.findings.find(row => row.detectorId === 'approval_friction')!;
    const refreshed = read(201).results[0]!.coach!.findings.find(row => row.detectorId === 'approval_friction')!;
    expect(first).toBeDefined();
    expect(refreshed).toMatchObject({ evidenceKey: first.evidenceKey, asOfMs: 201, period: { startMs: 100, endMs: 201 } });
    const changed = read(201, 170).results[0]!.coach!.findings.find(row => row.detectorId === 'approval_friction')!;
    expect(changed.evidenceKey).not.toBe(first.evidenceKey);
  });
  it('keeps opened allowance facts separate from accounting totals', () => {
    const query = normalizeUsageQuery({});
    const allowance = { source: { bindingKind: 'account' as const, ref: {
      service: { pluginId: 'test.provider', localId: 'account' }, accountId: 'personal',
    } }, current: null, pace: [], targets: [], waitingWork: { status: 'unavailable' as const, reason: 'read_failed' as const } };
    const result = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: accounting, status: 'available' }],
      quota: { status: 'available', value: [allowance] } });
    expect(result.results[0]?.quota).toEqual([allowance]);
    expect(result.results[0]?.accounting?.totals).toEqual(accounting.totals);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0],
      sources: [{ source: 'quota', status: 'error', errorCode: 'denied' }] }] }).success).toBe(false);
  });
  it('retains exact-query authorized facts on refresh failure without retaining denied or changed-scope facts', () => {
    const query = normalizeUsageQuery({ agents: ['a'] });
    const other = normalizeUsageQuery({ agents: ['b'] });
    const previous = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: accounting, status: 'available' }] });
    const refreshed = resolveUsagePageAggregation({ queries: [query, other], previous,
      accounting: [{ query, status: 'error', errorCode: 'usage_analytics_query_failed' }, { query: other, status: 'error' }] });
    expect(refreshed.results[0]?.accounting).toEqual(accounting);
    expect(refreshed.results[0]?.sources).toContainEqual({ source: 'accounting', status: 'error', errorCode: 'usage_analytics_query_failed' });
    expect(refreshed.results[1]?.accounting).toBeUndefined();
    for (const errorCode of ['denied', 'permission_denied']) {
      const denied = resolveUsagePageAggregation({ queries: [query], previous, accounting: [{ query, status: 'error', errorCode }] });
      expect(denied.results[0]?.accounting).toBeUndefined();
    }
  });
  it('projects producer progress only into the slice that observed it', () => {
    const query = normalizeUsageQuery({ agents: ['a'] });
    const other = normalizeUsageQuery({ agents: ['b'] });
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, coverage: {
      status: 'partial', reasons: ['incomplete_history'], missingDimensions: [], range: { complete: false }, ranked: [],
      sources: [{ source: 'native:capture', path: 'native', status: 'pending', eventCount: 1, asOfMs: 200 }],
    } });
    const result = resolveUsagePageAggregation({ queries: [query, other], accounting: [{ query, value, status: 'available' }] });
    expect(result.results[0]?.sources).toContainEqual({ source: 'native:capture', status: 'pending', asOfMs: 200 });
    expect(result.results[1]?.sources.some(source => source.source === 'native:capture')).toBe(false);
  });
  it('retains exact preceding-period facts on ordinary comparison refresh failure', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const comparison = normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 100 } });
    const previous = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, value: accounting, status: 'available' }, { query: comparison, value: accounting, status: 'available', asOfMs: 100 },
    ] });
    const result = resolveUsagePageAggregation({ queries: [query], previous, accounting: [
      { query, value: accounting, status: 'available' }, { query: comparison, status: 'error', errorCode: 'usage_query_failed' },
    ] });
    expect(result.results[0]?.comparison).toMatchObject({ accounting, source: { status: 'error', asOfMs: 100 } });
    const denied = resolveUsagePageAggregation({ queries: [query], previous, accounting: [
      { query, value: accounting, status: 'available' }, { query: comparison, status: 'error', errorCode: 'permission_denied' },
    ] });
    expect(denied.results[0]?.accounting).toEqual(accounting);
    expect(denied.results[0]?.comparison?.accounting).toBeUndefined();
  });
  it('exposes private witnessed work only on its exact admitted query slice', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const other = normalizeUsageQuery({ period: { startMs: 0, endMs: 100 } });
    const result = resolveUsagePageAggregation({ queries: [query, other], howYouWork: [{ query, detail: {
      status: 'partial', facts: [{ workId: 't', evidenceId: 't', kind: 'busy', agentId: null, machineId: null, startMs: 100, endMs: 180 }],
      permissions: [], acceptedInputs: [],
    } }] });
    expect(result.results[0]?.howYouWork).toMatchObject({ detailStatus: 'partial', intervals: { elapsedBusyMs: 80 } });
    expect(result.results[1]?.howYouWork).toMatchObject({ detailStatus: 'unknown', intervals: null });
    const pending = resolveUsagePageAggregation({ queries: [query], previous: result,
      sources: [{ source: 'how_you_work', status: 'pending' }] });
    expect(pending.results[0]?.howYouWork).toEqual(result.results[0]?.howYouWork);
    expect(pending.results[0]?.coach?.currentness).not.toBe('current');
    const unavailable = resolveUsagePageAggregation({ queries: [query], previous: result,
      howYouWork: [{ query, detail: { status: 'unknown' } }] });
    expect(unavailable.results[0]?.howYouWork?.intervals).toBeNull();
  });
  it('honors Account check choices before evaluation and while prior detail is retained', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const detail = { status: 'partial' as const, permissions: [{ workId: 'turn', requestId: 'permission',
      requestedAtMs: 120, decidedAtMs: 160, toolId: 'Bash', answeringClientCategory: null }], facts: [], acceptedInputs: [] };
    const previous = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, detail, asOfMs: 200 }] });
    expect(previous.results[0]!.coach!.findings.some(finding => finding.detectorId === 'approval_friction')).toBe(true);
    const coachPreferences = { v: 1 as const, suppressions: [], disabledChecks: ['approval_friction' as const], modelSuggestion: 'off' as const };
    for (const source of [{ howYouWork: [{ query, detail, asOfMs: 200 }] },
      { previous, sources: [{ source: 'how_you_work', status: 'pending' as const }] }]) {
      const coach = resolveUsagePageAggregation({ queries: [query], ...source, coachPreferences }).results[0]!.coach!;
      expect(coach.evaluations.find(row => row.detectorId === 'approval_friction')?.status).toBe('disabled');
      expect(coach.evaluations.find(row => row.detectorId === 'model_misfit')?.status).toBe('disabled');
      expect(coach.findings).toEqual([]);
    }
    const disabled = resolveUsagePageAggregation({ queries: [query], howYouWork: [{ query, detail, asOfMs: 200 }], coachPreferences });
    const enabledAgain = resolveUsagePageAggregation({ queries: [query], previous: disabled,
      sources: [{ source: 'how_you_work', status: 'pending' }] }).results[0]!.coach!;
    expect(enabledAgain.evaluations.find(row => row.detectorId === 'approval_friction')?.status).toBe('insufficient_evidence');
    const openQuery = normalizeUsageQuery({ period: { startMs: 100 } });
    const openPrevious = resolveUsagePageAggregation({ queries: [openQuery], howYouWork: [{ query: openQuery, detail, asOfMs: 200 }] });
    const openPending = resolveUsagePageAggregation({ queries: [openQuery], previous: openPrevious, coachPreferences,
      sources: [{ source: 'how_you_work', status: 'pending' }] }).results[0]!.coach!;
    expect(openPending.evaluations.find(row => row.detectorId === 'approval_friction')?.status).toBe('disabled');
    const unavailable = resolveUsagePageAggregation({ queries: [query], previous,
      sources: [{ source: 'how_you_work', status: 'pending' }], coachPreferences: null }).results[0]!.coach!;
    expect(unavailable.findings).toEqual([]);
    expect(unavailable.evaluations.every(row => row.status === 'insufficient_evidence')).toBe(true);
  });
  it('composes Work only from the exact admitted accounting query and witnessed turns', () => {
    const query = normalizeUsageQuery({ session: 'session', period: { startMs: 100, endMs: 200 } });
    const other = normalizeUsageQuery({ ...query, agents: ['other'] });
    const contribution = { id: 'cost', observedAtMs: 150, sessionId: 'session', turnId: 'turn', agentId: null,
      modelId: null, machineId: null, projectKey: null, workspaceId: null, source: null, tokens,
      cost: { reportedUsd: 0.02, estimatedUsd: 0, currency: 'USD' } };
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting, contributions: [contribution] });
    const witness: UsageWorkEvidence = { sessionId: 'session', turnId: 'turn', repositoryKey: 'repo',
      checkpointRef: 'checkpoint', checkpointCommitSha: 'a'.repeat(40), commitSha: 'b'.repeat(40),
      attributionScope: 'no_happier_checkpoint_overlap_observed', pullRequest: {
        provider: { id: 'forge', kind: 'github', displayName: 'Forge', baseUrl: 'https://github.com',
          nameWithOwner: 'owner/repo', urlSafety: { allowedSchemes: ['https:'] } },
        number: 1, title: 'Work', url: 'https://github.com/owner/repo/pull/1', baseBranch: 'main', headBranch: 'feature', state: 'open',
      } };
    const result = resolveUsagePageAggregation({ queries: [query, other], accounting: [{ query, value, status: 'available' }],
      work: [{ query, status: 'partial', evidence: [witness] }] });
    expect(result.results[0]?.work?.allocations).toMatchObject([{ contribution, reason: 'allocated', outcome: { repositoryKey: 'repo' } }]);
    expect(result.results[0]?.sources).toContainEqual({ source: 'work', status: 'partial' });
    expect(result.results[1]?.work).toBeUndefined();
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
    const pending = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }],
      work: [{ query, status: 'pending' }], previous: result });
    expect(pending.results[0]?.work).toEqual(result.results[0]?.work);
    const changedValue = UsageAnalyticsQueryResponseSchema.parse({ ...value, contributions: [{ ...contribution, tokens: { ...tokens, input: 14, total: 18 } }] });
    const changed = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value: changedValue, status: 'available' }],
      work: [{ query, status: 'pending' }], previous: result });
    expect(changed.results[0]?.work?.allocations[0]).toMatchObject({ contribution: { tokens: { input: 14, total: 18 } }, reason: 'allocated' });
    let failed = result;
    for (let attempt = 0; attempt < 2; attempt++) {
      failed = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }], previous: failed,
        work: [{ query, status: 'error', errorCode: 'work_evidence_failed' }] });
      expect(failed.results[0]?.work).toEqual(result.results[0]?.work);
      expect(failed.results[0]?.sources).toContainEqual({ source: 'work', status: 'stale', errorCode: 'work_evidence_failed' });
      expect(UsageQueryBatchResultSchema.safeParse(failed).success).toBe(true);
    }
    const recoveredEmpty = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }], previous: failed,
      work: [{ query, status: 'partial', evidence: [] }] });
    expect(recoveredEmpty.results[0]?.work?.outcomes).toEqual([]);
    const quarantined = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }], previous: failed,
      work: [{ query, status: 'error', errorCode: 'work_evidence_failed', evidence: [], branchEvidence: [] }] });
    expect(quarantined.results[0]?.work?.outcomes).toEqual([]);
    const revoked = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, value, status: 'available' }],
      work: [{ query, status: 'error', errorCode: 'unauthorized', evidence: [witness] }], previous: result });
    expect(revoked.results[0]?.work?.allocations).toMatchObject([{ contribution, reason: 'missing_evidence', outcome: null, evidence: [] }]);
    expect(revoked.results[0]?.work?.outcomes).toEqual([]);
    expect(revoked.results[0]?.sources).toContainEqual({ source: 'work', status: 'error', errorCode: 'unauthorized' });
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0], accounting }] }).success).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0],
      sources: [{ source: 'work', status: 'unsupported' }] }] }).success).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0], work: {
      ...result.results[0]!.work, allocations: result.results[0]!.work!.allocations.map(row => ({ ...row, reason: 'missing_evidence' })),
    } }] }).success).toBe(false);
  });
  it('settles admitted private detail independently of a pending sibling source', () => {
    const query = normalizeUsageQuery({ period: { startMs: 0, endMs: 100 }, includeWorkEvidence: false });
    const sibling = normalizeUsageQuery({ ...query, agents: ['codex'] });
    const result = resolveUsagePageAggregation({ queries: [query, sibling],
      accounting: [query, sibling].map(query => ({ query, status: 'available' as const, value: accounting })),
      quota: { status: 'unsupported' },
      howYouWork: [{ query, asOfMs: 100, detail: { status: 'partial', facts: [] } }],
      sources: [{ source: 'how_you_work', status: 'pending' }],
    });
    expect(result.results[0]?.pending).toBe(false);
    expect(result.results[0]?.sources.filter(source => source.source === 'how_you_work'))
      .toEqual([{ source: 'how_you_work', status: 'partial', asOfMs: 100 }]);
    expect(result.results[1]?.pending).toBe(true);
    expect(result.results[1]?.sources).toContainEqual({ source: 'how_you_work', status: 'pending' });
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
  });

  it('shares equivalent requests while keeping independently pinned requests separate', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, agents: ['b', 'a'] });
    const equivalent = normalizeUsageQuery({ ...query, agents: ['a', 'b', 'a'] });
    const pinned = normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 100 } });
    const result = resolveUsagePageAggregation({ queries: [query, equivalent, pinned], accounting: [
      { query, status: 'available', value: accounting, asOfMs: 200 },
    ], quota: { status: 'pending' } });
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.accounting?.totals.tokens.total).toBe(16);
    expect(result.results[0]?.requestedQuery.period).toEqual({ startMs: 100, endMs: 200 });
    expect(result.results[1]?.accounting).toBeUndefined();
    expect(result.results[1]?.shownQuery.period).toEqual({ startMs: 0, endMs: 100 });
    expect(result.results.every(slice => slice.pending)).toBe(true);
    expect(UsageQueryBatchResultSchema.safeParse(result).success).toBe(true);
  });

  it('retains A facts without manufacturing zeros while quota and capture are pending', () => {
    const query = normalizeUsageQuery({});
    const result = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'available', value: accounting },
    ], quota: { status: 'not_loaded' }, sources: [{ source: 'native:capture', status: 'pending' }] });
    expect(result.results[0]?.accounting?.totals).toEqual(accounting.totals);
    expect(result.results[0]).not.toHaveProperty('quota');
    expect(result.results[0]?.sources).toEqual([
      { source: 'accounting', status: 'available' },
      { source: 'quota', status: 'not_loaded' },
      { source: 'work', status: 'not_loaded' },
      { source: 'native:capture', status: 'pending' },
    ]);
    expect(result.results[0]?.pending).toBe(true);
  });

  it('keeps unchanged slices referentially stable when another source advances', () => {
    const query = normalizeUsageQuery({ agents: ['a'] });
    const other = normalizeUsageQuery({ agents: ['b'] });
    const first = resolveUsagePageAggregation({ queries: [query, other], accounting: [
      { query, status: 'available', value: accounting },
    ] });
    const next = resolveUsagePageAggregation({ queries: [query, other], previous: first, accounting: [
      { query, status: 'available', value: accounting }, { query: other, status: 'available', value: accounting },
    ] });
    expect(next.results[0]).toBe(first.results[0]);
    expect(next.results[1]).not.toBe(first.results[1]);
    expect(next.results[1]?.accounting?.totals.tokens.total).toBe(16);
  });

  it('retains accounting identities while independent source progress replaces their slice', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    const comparisonQuery = normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 100 } });
    const value = UsageAnalyticsQueryResponseSchema.parse({ ...accounting,
      priceCatalog: { ...bundledUsageModelPriceCatalog, models: { model: { inputUsdPerMillion: 2, outputUsdPerMillion: 1 } } },
      coverage: { status: 'complete', reasons: [], missingDimensions: [], range: { complete: true }, ranked: [],
        sources: [{ source: 'runtime', path: 'runtime', status: 'available', eventCount: 1, machineId: 'machine' }] },
    });
    const compose = (previous: ReturnType<typeof resolveUsagePageAggregation> | undefined,
      status: 'pending' | 'available', displayLocation: string, current = value) => resolveUsagePageAggregation({
        queries: [query], previous, nowMs: 200,
        sourceLocations: [{ machineId: 'machine', displayLocation }],
        accounting: [{ query, status: 'available', value: current },
          { query: comparisonQuery, status: 'available', value }],
        sources: [{ source: 'how_you_work', status }],
      });
    const initial = compose(undefined, 'pending', 'Dev box');
    const settled = compose(initial, 'available', 'Dev box');
    expect(settled.results[0]).not.toBe(initial.results[0]);
    expect(settled.results[0]?.sources).toContainEqual({ source: 'how_you_work', status: 'available' });
    // Source progress must not invalidate the existing accounting-keyed view
    // projections or their contribution/ranking work in every mounted body.
    expect(settled.results[0]?.accounting).toBe(initial.results[0]?.accounting);
    expect(settled.results[0]?.comparison?.accounting).toBe(initial.results[0]?.comparison?.accounting);
    expect(settled.results[0]?.planInsights).toBe(initial.results[0]?.planInsights);
    expect(settled.results[0]?.comparison).toBe(initial.results[0]?.comparison);
    const renamed = compose(settled, 'available', 'Renamed box');
    expect(renamed.results[0]?.accounting).not.toBe(settled.results[0]?.accounting);
    expect(renamed.results[0]?.accounting?.coverage?.sources[0]?.displayLocation).toBe('Renamed box');
    const changed = compose(renamed, 'available', 'Renamed box', {
      ...structuredClone(value), totals: { ...value.totals, eventCount: 2 },
    });
    expect(changed.results[0]?.accounting?.totals.eventCount).toBe(2);
    expect(changed.results[0]?.accounting?.priceCatalog).toBe(renamed.results[0]?.accounting?.priceCatalog);
    expect(changed.results[0]?.comparison?.accounting).toBe(renamed.results[0]?.comparison?.accounting);
    const repriced = compose(changed, 'available', 'Renamed box', { ...value,
      priceCatalog: { ...value.priceCatalog!, models: { model: { inputUsdPerMillion: 3, outputUsdPerMillion: 1 } } },
    });
    expect(repriced.results[0]?.accounting?.priceCatalog).not.toBe(changed.results[0]?.accounting?.priceCatalog);
    expect(repriced.results[0]?.accounting?.priceCatalog?.models.model?.inputUsdPerMillion).toBe(3);
    const reobserved = compose(changed, 'available', 'Renamed box', { ...value,
      priceCatalog: { ...structuredClone(value.priceCatalog!), provenance: { ...value.priceCatalog!.provenance,
        asOfMs: value.priceCatalog!.provenance.asOfMs + 1 } },
    });
    expect(reobserved.results[0]?.accounting?.priceCatalog?.models).toBe(changed.results[0]?.accounting?.priceCatalog?.models);
    expect(reobserved.results[0]?.accounting?.priceCatalog?.provenance.asOfMs).toBe(value.priceCatalog!.provenance.asOfMs + 1);
    const withdrawn = resolveUsagePageAggregation({ queries: [query], previous: changed,
      accounting: [{ query, status: 'not_loaded' }] });
    expect(withdrawn.results[0]?.accounting).toBeUndefined();
  });

  it('refuses mismatched shown-query identity and unavailable facts in the public result', () => {
    const query = normalizeUsageQuery({});
    const result = resolveUsagePageAggregation({ queries: [query] });
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, results: [{ ...result.results[0], key: 'wrong' }] }).success).toBe(false);
    expect(UsageQueryBatchResultSchema.safeParse({ ...result, credentials: 'not query authority' }).success).toBe(false);
  });

  it('names and composes the exact preceding range without assigning those facts to the current period', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, timeZoneOffsetMinutes: 120 });
    const previousPeriod = normalizeUsageQuery({ ...query, period: { startMs: 0, endMs: 100 } });
    const result = resolveUsagePageAggregation({ queries: [query], accounting: [
      { query, status: 'pending' }, { query: previousPeriod, status: 'available', value: accounting },
    ] });
    expect(result.results[0]).toMatchObject({
      requestedQuery: { period: { startMs: 100, endMs: 200 } },
      comparison: { query: { period: { startMs: 0, endMs: 100 }, timeZoneOffsetMinutes: 120 }, accounting },
    });
    expect(result.results[0]?.accounting).toBeUndefined();
  });
});
