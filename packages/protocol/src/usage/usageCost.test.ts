import { expect, it } from 'vitest';
import { projectUsagePageCost, repriceUsageAnalyticsResponse, repriceUsageObservationCost, resolveUsageCostFacts, resolveUsageCostBasis, resolveEffectiveUsageCostUsd } from './usageCost.js';
import { bundledUsageModelPriceCatalog } from './usageModelPriceCatalog.js';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema, type UsageAnalyticsQueryResponse } from './usageAnalyticsContracts.js';
import { addUsageCostForMode, createEmptyUsageCost } from './usageAggregation.js';

it('never reclassifies a mixed aggregate with none provenance as reported money', () => {
  const mixed = { reportedUsd: 4, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
  expect(resolveUsageCostBasis(mixed, 'reported')).toBeNull();
  expect(resolveEffectiveUsageCostUsd(mixed, 'reported')).toBe(0);
});

it('recognizes explicit zero pricing while leaving default zero unpriced', () => {
  const zero = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
  expect(resolveUsageCostBasis({ ...zero, costSource: 'none' }, 'auto')).toBeNull();
  expect(resolveUsageCostBasis({ ...zero, costSource: 'pricing_estimate' }, 'auto')).toMatchObject({ kind: 'estimated', amountUsd: 0 });
});

it('does not restore an incomplete API tariff population when a later row is priced', () => {
  const unpriced = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const };
  const priced = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' as const, apiEquivalentUsd: 9 };
  const cost = addUsageCostForMode(addUsageCostForMode(createEmptyUsageCost(), unpriced, 'api_equivalent'), priced, 'api_equivalent');
  expect(cost.apiEquivalentUsd).toBeUndefined();
  expect(resolveUsageCostBasis(cost, 'api_equivalent')).toBeNull();
});

it('keeps a money-only final from invalidating fully priced token accounting', () => {
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const cost = { reportedUsd: 0, estimatedUsd: 1, currency: 'USD', costSource: 'pricing_estimate' };
  const response: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 2, tokens,
    cost: { reportedUsd: 7, estimatedUsd: 1, currency: 'USD', costSource: 'none' } },
    contributions: [{ id: 'inference', observedAtMs: 1, sessionId: 'session', turnId: 'turn', agentId: 'claude',
      modelId: 'priced-model', machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens, cost },
      { id: 'final', observedAtMs: 2, sessionId: 'session', turnId: null, agentId: 'claude', modelId: null,
        machineId: null, projectKey: null, workspaceId: null, source: 'final', tokens: zero,
        cost: { reportedUsd: 7, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' } }],
  };
  const result = repriceUsageAnalyticsResponse(response, { v: 1,
    models: { 'priced-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 3 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'fixture', fetchStatus: 'ready' },
  }, {}, 'api_equivalent');
  expect(result.totals.cost.apiEquivalentUsd).toBe(2);
  expect(result.costPresentation).toMatchObject({ mode: 'api_equivalent', effectiveUsd: 2 });
  expect(projectUsagePageCost(result, 'api_equivalent').amountUsd).toBe(2);
  expect(result.costFacts?.some(fact => fact.kind === 'unpriced')).toBe(false);
});

it('keeps vendor API-equivalent reports a separate reported fact regardless of current tariff availability', () => {
  const raw = { reportedUsd: 7, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported_api_equivalent' as const };
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const unpriced = repriceUsageObservationCost(raw, 'private-model', tokens);
  expect(resolveUsageCostFacts(unpriced)).toContainEqual(expect.objectContaining({ kind: 'reported', amountUsd: 7,
    source: 'provider_reported_api_equivalent' }));
  const priced = repriceUsageObservationCost(raw, 'private-model', tokens, bundledUsageModelPriceCatalog,
    { 'private-model': { kind: 'rates', inputUsdPerMillion: 2, outputUsdPerMillion: 3 } }, 'api_equivalent');
  expect(priced).toMatchObject({ ...raw, apiEquivalentUsd: 2, effectiveUsd: 2 });
  expect(resolveUsageCostFacts(priced)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'reported', amountUsd: 7, source: 'provider_reported_api_equivalent' }),
    expect.objectContaining({ kind: 'api_equivalent', amountUsd: 2 }),
  ]));
});

it('prefers reported money for best available while keeping invoice and estimates separate', () => {
  const cost = { reportedUsd: 0.12, estimatedUsd: 0.09, invoiceUsd: 0.08, currency: 'USD' };
  expect(resolveUsageCostBasis(cost, 'auto')).toMatchObject({ kind: 'reported', amountUsd: 0.12 });
  expect(resolveUsageCostFacts(cost)).toContainEqual(expect.objectContaining({ kind: 'invoice', amountUsd: 0.08 }));
  expect(resolveUsageCostBasis(cost, 'reported')).toMatchObject({ kind: 'reported', amountUsd: 0.12 });
  expect(resolveUsageCostBasis(cost, 'estimated')).toMatchObject({ kind: 'estimated', amountUsd: 0.09 });
});

it('returns an admitted API-equivalent query mode through the strict response contract', () => {
  const request = UsageAnalyticsQueryRequestSchema.parse({ costMode: 'api_equivalent' });
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const cost = { reportedUsd: 7, estimatedUsd: 0, currency: 'USD' };
  const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 1, tokens, cost },
    contributions: [{ id: 'observed', observedAtMs: 1, sessionId: 'session', turnId: null, agentId: null,
      modelId: 'priced-model', machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens, cost }],
  });
  const repriced = repriceUsageAnalyticsResponse(response, {
    v: 1, models: { 'priced-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 3 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'fixture', fetchStatus: 'ready' },
  }, {}, request.costMode);
  expect(UsageAnalyticsQueryResponseSchema.parse(repriced).costPresentation)
    .toMatchObject({ mode: 'api_equivalent', effectiveUsd: 2, currency: 'USD' });
  expect(repriced.totals.cost.reportedUsd).toBe(7);
});

it('projects one common page basis without repricing witnessed facts or changing observation auto precedence', () => {
  const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
  const costs = [
    { reportedUsd: 3, estimatedUsd: 4, invoiceUsd: 2, apiEquivalentUsd: 8, currency: 'USD' },
    { reportedUsd: 5, estimatedUsd: 6, apiEquivalentUsd: 9, currency: 'USD' },
  ];
  const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
    totals: { eventCount: 2, tokens: { ...tokens, total: 2 }, cost: { reportedUsd: 8, estimatedUsd: 10, currency: 'USD', costSource: 'none' } },
    contributions: costs.map((cost, index) => ({ id: String(index), observedAtMs: index, eventCount: 1,
      sessionId: 'session', turnId: null, agentId: 'claude', modelId: 'private', machineId: null,
      projectKey: null, workspaceId: null, source: 'runtime', tokens, cost })),
  });
  const page = projectUsagePageCost(response, 'auto');
  expect(page).toMatchObject({ selection: { kind: 'reported', currency: 'USD' }, amountUsd: 8 });
  expect(page.accounting.contributions).toEqual(response.contributions);
  expect(resolveUsageCostBasis(costs[0]!, 'auto')?.kind).toBe('reported');
  expect(projectUsagePageCost(response, 'api_equivalent')).toMatchObject({ amountUsd: 17,
    selection: { kind: 'api_equivalent', currency: 'USD' } });
  expect(projectUsagePageCost(response, 'auto', { kind: 'invoice', currency: 'USD' }).amountUsd).toBeNull();
  expect(projectUsagePageCost(response, 'auto', { kind: 'reported', currency: 'EUR' }).amountUsd).toBeNull();
});

it('sums best available reported and priced rows with a mixed label, keeping unknown and currencies separate', () => {
  const reported = { reportedUsd: 3, estimatedUsd: 4, apiEquivalentUsd: 8, currency: 'USD' };
  const priced = { reportedUsd: 0, estimatedUsd: 6, apiEquivalentUsd: 9, currency: 'USD', costSource: 'pricing_estimate' as const };
  const mixed = addUsageCostForMode(addUsageCostForMode(createEmptyUsageCost(), reported, 'auto'), priced, 'auto');
  expect(resolveUsageCostBasis(mixed, 'auto')).toMatchObject({ kind: 'mixed', amountUsd: 12, currency: 'USD' });
  expect(resolveUsageCostBasis(addUsageCostForMode(mixed, { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' }, 'auto'), 'auto')).toBeNull();
  expect(resolveUsageCostBasis(addUsageCostForMode(mixed, { ...reported, currency: 'EUR' }, 'auto'), 'auto')).toBeNull();
  expect(resolveUsageCostBasis(addUsageCostForMode(reported, priced, 'reported'), 'reported')).toBeNull();
  expect(resolveUsageCostFacts(mixed)).toContainEqual(expect.objectContaining({ kind: 'reported', amountUsd: 3 }));
  expect(mixed.costSource).toBe('none');
  expect(addUsageCostForMode(addUsageCostForMode(createEmptyUsageCost(), priced, 'auto'), reported, 'auto').costSource).toBe('none');
});

it('uses the admitted selected presentation after JSON transport when contribution detail is absent', () => {
  const reported = { reportedUsd: 10, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const };
  const estimated = { reportedUsd: 0, estimatedUsd: 10, currency: 'USD', costSource: 'pricing_estimate' as const };
  const aggregate = addUsageCostForMode(addUsageCostForMode(createEmptyUsageCost(), reported, 'auto'), estimated, 'auto');
  const wire = UsageAnalyticsQueryResponseSchema.parse(JSON.parse(JSON.stringify({ v: 1,
    totals: { eventCount: 2, tokens: { input: 2, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: aggregate },
    costPresentation: { mode: 'auto', effectiveUsd: 20, currency: 'USD', source: 'best_available' },
  })));
  expect(wire.totals.cost).toMatchObject({ reportedUsd: 10, estimatedUsd: 10, costSource: 'none' });
  expect(projectUsagePageCost(wire, 'auto')).toMatchObject({ selection: { kind: 'mixed', currency: 'USD', mode: 'auto' }, amountUsd: 20 });
  expect(projectUsagePageCost(wire, 'reported').amountUsd).toBeNull();
  expect(projectUsagePageCost(wire, 'auto', { kind: 'reported', currency: 'USD' }).amountUsd).toBeNull();
  expect(projectUsagePageCost(wire, 'auto', { kind: 'mixed', currency: 'EUR', mode: 'auto' }).amountUsd).toBeNull();
});

it('re-prices best-available totals and buckets with the same mixed basis as their leaders', () => {
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const costs = [
    { reportedUsd: 3, estimatedUsd: 4, currency: 'USD', costSource: 'provider_reported' },
    { reportedUsd: 0, estimatedUsd: 6, currency: 'USD', costSource: 'pricing_estimate' },
  ];
  const total = { eventCount: 2, tokens: { ...tokens, input: 2_000_000, total: 2_000_000 },
    cost: { reportedUsd: 3, estimatedUsd: 10, currency: 'USD', costSource: 'none' } };
  const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: total,
    series: [{ ...total, bucketStartMs: 0, bucketEndMs: 10 }],
    leaders: { agents: [{ key: 'claude', ...total }] },
    contributions: costs.map((cost, index) => ({ id: String(index), observedAtMs: index, eventCount: 1,
      sessionId: 'session', turnId: null, agentId: 'claude', modelId: 'priced-model', machineId: null,
      projectKey: null, workspaceId: null, source: 'runtime', tokens, cost })),
  });
  const result = UsageAnalyticsQueryResponseSchema.parse(repriceUsageAnalyticsResponse(response, {
    v: 1, models: { 'priced-model': { inputUsdPerMillion: 9, outputUsdPerMillion: 0 } },
    provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'fixture', fetchStatus: 'ready' },
  }));
  expect(result.totals.cost).toMatchObject({ reportedUsd: 3, estimatedUsd: 10, apiEquivalentUsd: 18, effectiveUsd: 12 });
  expect(result.series?.[0]?.cost.effectiveUsd).toBe(12);
  expect(result.leaders?.agents?.[0]?.cost?.effectiveUsd).toBe(12);
  expect(result.costPresentation).toMatchObject({ mode: 'auto', effectiveUsd: 12, currency: 'USD', source: 'best_available' });
  expect(result.totals.cost.costSource).toBe('none');
  expect(projectUsagePageCost(JSON.parse(JSON.stringify(result)), 'auto')).toMatchObject({
    selection: { kind: 'mixed', currency: 'USD' }, amountUsd: 12,
  });
  expect(result.costFacts).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'reported', amountUsd: 3 }),
    expect.objectContaining({ kind: 'estimated', amountUsd: 10 }),
    expect.objectContaining({ kind: 'api_equivalent', amountUsd: 18 }),
  ]));
});

it('distinguishes witnessed zero from absent money in the page projection', () => {
  const response = (costSource: 'none' | 'provider_reported') => UsageAnalyticsQueryResponseSchema.parse({ v: 1,
    totals: { eventCount: 1, tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
      cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource } },
  });
  expect(projectUsagePageCost(response('none'), 'auto').amountUsd).toBeNull();
  expect(projectUsagePageCost(response('provider_reported'), 'auto').amountUsd).toBe(0);
});

it('does not expose stale aggregate money when a selected API-equivalent bucket is partly unpriced', () => {
  const tokens = { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 };
  const cost = { reportedUsd: 3, estimatedUsd: 0, apiEquivalentUsd: 9, currency: 'USD' };
  const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 2, tokens, cost },
    series: [{ bucketStartMs: 0, bucketEndMs: 10, eventCount: 2, tokens, cost }],
    contributions: [cost, { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' }].map((cost, index) => ({
      id: String(index), observedAtMs: index, eventCount: 1, sessionId: 'session', turnId: null,
      agentId: 'claude', modelId: null, machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens, cost,
    })),
  });
  const page = projectUsagePageCost(response, 'api_equivalent');
  expect(page.amountUsd).toBeNull();
  expect(resolveUsageCostBasis(page.accounting.series![0]!.cost, 'api_equivalent')).toBeNull();
});
