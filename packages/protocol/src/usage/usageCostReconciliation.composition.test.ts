import { expect, it } from 'vitest';
import { resolveScopedUsageContributions, type ScopedUsageEventRow } from '../../../../apps/server/sources/app/usage/query/resolveScopedUsageContributions';
import { buildUsageResultProjection } from '../../../../apps/server/sources/app/usage/query/buildUsageResultProjection';
import { aggregateUsageContributionCosts, createEmptyUsageCost, createEmptyUsageTokens } from './usageAggregation.js';
import { repriceUsageAnalyticsResponse, projectUsagePageCost, resolveUsageCostBasis } from './usageCost.js';
import type { UsageAnalyticsQueryRequest } from './usageAnalyticsContracts.js';

it.each([20, 100])('selects the whole-call reported final once after %i priced inference tokens', total => {
  const row = (id: string, time: number, tokens: number): ScopedUsageEventRow => ({
    id, observedAt: new Date(time), createdAt: new Date(time), sessionId: 'session', agentId: 'claude',
    scope: id === 'final' ? 'session_final' : 'turn_delta', isCumulative: id === 'final', source: id,
    modelId: id === 'final' ? null : 'priced-model', turnId: null, machineId: null,
    backendMode: null, projectKey: null, workspaceId: null, contextUsedTokens: null, contextWindowTokens: null,
    tokens: { ...createEmptyUsageTokens(), input: tokens, total: tokens },
    cost: id === 'final' ? { ...createEmptyUsageCost(), reportedUsd: 0.12, costSource: 'provider_reported' }
      : { ...createEmptyUsageCost(), estimatedUsd: total / 100, costSource: 'pricing_estimate' },
  });
  const rows = [row('inference', 100, total), row('final', 200, 100)];
  const resolved = resolveScopedUsageContributions(rows);
  const request: UsageAnalyticsQueryRequest = { granularity: 'day', timeZoneOffsetMinutes: 0, topLimit: 10, includeSeries: true };
  const projection = buildUsageResultProjection({ contributions: resolved.totalContributions,
    evidenceRows: rows, coverageReasons: resolved.coverageReasons, request });
  const result = repriceUsageAnalyticsResponse({ v: 1, totals: { eventCount: 2,
    tokens: rows[1]!.tokens, cost: { ...createEmptyUsageCost(), reportedUsd: 0.12, estimatedUsd: total / 100 } },
    ...projection,
  }, { v: 1, models: { 'priced-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 0 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'fixture', fetchStatus: 'ready' } });
  expect(result.costPresentation?.effectiveUsd).toBeCloseTo(0.12, 10);
  expect(projectUsagePageCost(result, 'auto').amountUsd).toBeCloseTo(0.12, 10);
  expect(result.costFacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'reported', amountUsd: 0.12 }),
    expect.objectContaining({ kind: 'estimated', amountUsd: total / 100 }),
  ]));
  const monetary = result.contributions!.find(row => row.cost.reportedUsd > 0)!;
  expect(monetary.tokens.total).toBe(0);
  const finalOnly = { ...result, contributions: result.contributions!.filter(row => row.observedAtMs === 200) };
  expect(projectUsagePageCost(finalOnly, 'auto').amountUsd).toBeNull();
  expect(projectUsagePageCost(finalOnly, 'reported').amountUsd).toBeNull();
  expect(projectUsagePageCost({ ...result, contributions: result.contributions!.filter(row => row.modelId === 'priced-model') }, 'auto').amountUsd).toBeNull();
  if (total === 100) {
    expect(result.totals.cost.apiEquivalentUsd).toBeCloseTo(0.0002, 10);
    expect(projectUsagePageCost(result, 'api_equivalent').amountUsd).toBeCloseTo(0.0002, 10);
    expect(resolveUsageCostBasis(aggregateUsageContributionCosts(result.contributions!, 'estimated'), 'estimated')?.amountUsd)
      .toBeCloseTo(1, 10);
  }
});
