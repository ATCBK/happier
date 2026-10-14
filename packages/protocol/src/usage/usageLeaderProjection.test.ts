import { expect, it } from 'vitest';
import { repriceUsageAnalyticsResponse } from './usageCost.js';
import { buildUsageBreakdownList } from './usageLeaderProjection.js';
import { UsageAnalyticsContributionSchema, UsageAnalyticsQueryResponseSchema } from './usageAnalyticsContracts.js';

const contribution = { id: 'row', observedAtMs: 1, sessionId: 'session', turnId: null, agentId: 'agent', modelId: 'model',
    machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
    tokens: { input: 1, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1 },
    cost: { reportedUsd: 0, estimatedUsd: 0, costSource: 'none', currency: 'USD' } };

it('uses one model identity for the real QA snapshot, alias and newer Haiku generation before ranking', () => {
    // Token amounts and model ids from the QA usage.query model ranking, 2026-10-11.
    const rows = [['claude-haiku-4-5-20251001', 2401080, 92], ['claude-haiku-4-5', 372302, 16],
        ['claude-haiku-5-5', 299832, 18]] as const;
    const ranking = buildUsageBreakdownList(rows.map(([modelId, total, eventCount]) => ({ ...contribution,
        modelId, eventCount, tokens: { ...contribution.tokens, input: total, total } })), 'model', 20, 'auto');
    expect(ranking.map(row => [row.key, row.tokens.total, row.eventCount])).toEqual([
        ['claude-haiku-4-5', 2773382, 108], ['claude-haiku-5-5', 299832, 18],
    ]);
});

it('retains source partitions and re-prices each partition from its own admitted contributions', () => {
    const tokens = { ...contribution.tokens, input: 1_000_000, total: 1_000_000 };
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 2, tokens: { ...tokens, input: 2_000_000, total: 2_000_000 }, cost: contribution.cost },
        engineTimeline: [{ bucketStartMs: 0, bucketEndMs: 100, leaders: [{ key: 'agent', eventCount: 2, tokens, cost: contribution.cost }] }],
        contributions: [
            { ...contribution, id: 'inside', eventCount: 1, tokens, sourceContext: { path: 'runtime', execution: 'happier' } },
            { ...contribution, id: 'outside', eventCount: 1, tokens, source: 'native', sourceContext: { path: 'native', execution: 'outside' } },
        ],
    });
    const result = repriceUsageAnalyticsResponse(response, { v: 1, models: { model: { inputUsdPerMillion: 2, outputUsdPerMillion: 1 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'source', fetchStatus: 'ready' } },
        { model: { kind: 'rates', inputUsdPerMillion: 3, outputUsdPerMillion: 1 } }, 'api_equivalent');
    expect(result.engineTimeline?.[0]?.leaders[0]).toMatchObject({ tokens: { total: 2_000_000 }, cost: { apiEquivalentUsd: 6 }, sources: [
        { source: 'native', path: 'native', execution: 'outside', tokens: { total: 1_000_000 }, cost: { apiEquivalentUsd: 3 } },
        { source: 'runtime', path: 'runtime', execution: 'happier', tokens: { total: 1_000_000 }, cost: { apiEquivalentUsd: 3 } },
    ] });
});

it('admits witnessed contribution event counts while retaining older missing counts', () => {
    expect(UsageAnalyticsContributionSchema.parse({ ...contribution, eventCount: 3, context: { usedTokens: 15, windowTokens: 100 } })).toMatchObject({ eventCount: 3, context: { usedTokens: 15, windowTokens: 100 } });
    expect(UsageAnalyticsContributionSchema.parse(contribution).eventCount).toBeUndefined();
    expect(UsageAnalyticsContributionSchema.safeParse({ ...contribution, eventCount: -1 }).success).toBe(false);
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 3, tokens: contribution.tokens, cost: contribution.cost },
        contributions: [{ ...contribution, eventCount: 3 }],
        coverage: { status: 'complete', reasons: [], sources: [], missingDimensions: [],
            range: { complete: true }, ranked: [] },
    });
    const result = repriceUsageAnalyticsResponse(response, { v: 1,
        models: { model: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'witnessed', fetchStatus: 'ready' },
    }, {}, 'api_equivalent');
    expect(result.costFacts?.find(fact => fact.kind === 'api_equivalent'))
        .toMatchObject({ eventCount: 3, complete: true });
});

it('recovers a server-omitted token-tied winner after a private price override', () => {
    const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
    const cost = { reportedUsd: 0, estimatedUsd: 7, costSource: 'pricing_estimate', currency: 'USD' };
    const leader = { key: 'a-model', label: 'a-model', eventCount: 2, tokens, cost };
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1, totals: { eventCount: 5, tokens: { ...tokens, input: 2_000_000, total: 2_000_000 }, cost },
        leaders: { models: [leader] }, breakdowns: { model: [leader] }, modelTimeline: [{ bucketStartMs: 0, bucketEndMs: 100, leaders: [leader] }],
        contributions: ['a-model', 'z-model'].map(modelId => ({ id: modelId, observedAtMs: 1, sessionId: 'session', turnId: null,
            agentId: 'agent', backendMode: null, modelId, machineId: null, projectKey: null, workspaceId: null, source: 'runtime',
            tokens, tokenCategories: tokens, cost })),
    });
    const admitted = { ...response, contributions: response.contributions!.map((row, index) => ({ ...row, eventCount: index === 0 ? 2 : 3,
        context: { usedTokens: index === 0 ? 5 : 15, windowTokens: 100 } })) };
    const result = repriceUsageAnalyticsResponse(admitted, {
        v: 1, models: { 'a-model': { inputUsdPerMillion: 2, outputUsdPerMillion: 3 }, 'z-model': { inputUsdPerMillion: 1, outputUsdPerMillion: 3 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'ranking', fetchStatus: 'ready' },
    }, { 'z-model': { kind: 'rates', inputUsdPerMillion: 10, outputUsdPerMillion: 3 } }, 'api_equivalent');
    expect(result.leaders?.models).toEqual([expect.objectContaining({ key: 'z-model', label: 'z-model', eventCount: 3,
        cost: expect.objectContaining({ apiEquivalentUsd: 10, effectiveUsd: 10 }) })]);
    expect(result.modelTimeline?.[0]?.leaders[0]?.key).toBe('z-model');
    expect(result.breakdowns?.model?.[0]).toMatchObject({ key: 'z-model', context: { usedTokens: 15, windowTokens: 100 } });
    expect(result.costFacts?.find(fact => fact.kind === 'api_equivalent' && fact.source.includes('user:'))?.eventCount).toBe(3);
});

it('retains older rankings honestly when missing event counts prevent reconstructing ties', () => {
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 3, tokens: contribution.tokens, cost: contribution.cost },
        contributions: [contribution], leaders: { models: [{ key: 'model', label: 'preserved label', eventCount: 3,
            tokens: contribution.tokens, cost: contribution.cost }] },
        coverage: { status: 'complete', reasons: [], sources: [], missingDimensions: [], range: { complete: true },
            ranked: [{ dimension: 'model', totalEntries: 1, returnedEntries: 1, complete: true }] },
    });
    const result = repriceUsageAnalyticsResponse(response, { v: 1, models: { model: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'ranking', fetchStatus: 'ready' } }, {}, 'api_equivalent');
    expect(result.leaders?.models?.[0]).toMatchObject({ key: 'model', label: 'preserved label', eventCount: 3 });
    expect(result.coverage).toMatchObject({ status: 'partial', reasons: ['ranked_truncation'], ranked: [{ complete: false }] });
    expect(result.costFacts?.find(fact => fact.kind === 'api_equivalent'))
        .toMatchObject({ eventCount: 1, complete: false });
});

it('re-prices a retained snapshot-key ranking without inventing missing legacy event counts', () => {
    const modelId = 'claude-haiku-4-5-20251001';
    const tokens = { ...contribution.tokens, input: 1_000_000, total: 1_000_000 };
    const response = UsageAnalyticsQueryResponseSchema.parse({ v: 1,
        totals: { eventCount: 3, tokens, cost: contribution.cost },
        contributions: [{ ...contribution, modelId, tokens }],
        breakdowns: { model: [{ key: modelId, eventCount: 3, tokens, cost: contribution.cost }] },
        leaders: { models: [{ key: modelId, eventCount: 3, tokens, cost: contribution.cost }] },
    });
    const result = repriceUsageAnalyticsResponse(response, {
        v: 1, models: { 'claude-haiku-4-5': { inputUsdPerMillion: 2, outputUsdPerMillion: 1 } },
        provenance: { source: 'litellm', origin: 'bundled', asOfMs: 1, revision: 'ranking', fetchStatus: 'ready' },
    }, {}, 'api_equivalent');
    expect(result.breakdowns?.model?.[0]).toMatchObject({ key: modelId, eventCount: 3, cost: { apiEquivalentUsd: 2 } });
    expect(result.leaders?.models?.[0]).toMatchObject({ key: modelId, eventCount: 3, cost: { apiEquivalentUsd: 2 } });
});
