import { estimateUsageModelCost, UsageAnalyticsQueryRequestSchema } from '@happier-dev/protocol';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { buildClaudeAssistantUsageObservation } from '../../../../../packages/plugins/claude/src/agent/usage/buildAssistantObservation';
import { buildClaudeSdkResultUsageObservation } from '../../../../../packages/plugins/claude/src/agent/usage/buildSdkResultObservation';
import { buildUsageEventIngestRequest } from '../../../../cli/src/usage/buildUsageEventIngestRequest';
import { queryUsageAnalytics } from './usageQueryService';
import { recordUsageEvent } from './usageWriteService';

// Cross-package composition belongs in the existing composed integration lane,
// separate from the server-only compiler project and aggregation fixtures.
describe('Claude usage producer → ingest → query', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-usage-composed-', initAuth: false });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    beforeEach(() => {
        harness.resetEnv();
    });

    afterEach(async () => {
        harness.resetEnv();
        await harness.resetDbTables([
            () => db.simpleCache.deleteMany({ where: { key: 'usage:model-price-catalog:v1' } }),
            () => db.usageEvent.deleteMany(),
            () => db.usageReport.deleteMany(),
            () => db.session.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it.each([20, 100])('does not inflate a whole-call final (%i earlier tokens)', async earlierTokens => {
        const account = await db.account.create({
            data: { publicKey: `pk-usage-query-claude-producer-${earlierTokens}` },
            select: { id: true },
        });
        const session = await db.session.create({
            data: { accountId: account.id, tag: `usage-query-claude-producer-${earlierTokens}`,
                encryptionMode: 'e2ee', metadata: 'ciphertext' },
            select: { id: true },
        });
        const querySession = (overrides: Readonly<Record<string, unknown>> = {}) => queryUsageAnalytics(
            account.id,
            UsageAnalyticsQueryRequestSchema.parse({ filters: { sessionIds: [session.id] },
                granularity: 'day', includeSeries: true, ...overrides }),
        );
        const modelId = 'claude-haiku-4-5';
        const assistant = buildClaudeAssistantUsageObservation({ modelId, turnId: 'turn',
            usage: { input_tokens: earlierTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
        const final = buildClaudeSdkResultUsageObservation({ modelId, result: { type: 'result', subtype: 'success', total_cost_usd: 0.12,
            modelUsage: { [modelId]: { inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } } });
        expect(assistant).not.toBeNull();
        expect(final).not.toBeNull();
        for (const [index, observation] of [assistant!, final!].entries()) {
            const request = buildUsageEventIngestRequest({ sessionId: session.id,
                observedAt: Date.UTC(2026, 6, index + 1), observation, externalKey: `event-${index}` });
            expect(request).not.toBeNull();
            expect(await recordUsageEvent(account.id, request!)).toMatchObject({ ok: true });
        }
        const result = await querySession({ breakdowns: ['model', 'source', 'session'] });
        expect(result.totals.tokens.total).toBe(100);
        expect(result.costPresentation?.effectiveUsd).toBeCloseTo(0.12, 10);
        expect(result.contributions?.find(row => row.cost.reportedUsd > 0)?.tokens.total).toBe(0);
        const finalDay = await querySession({ dateRange: { startMs: Date.UTC(2026, 6, 2), endMs: Date.UTC(2026, 6, 3) } });
        expect(finalDay.costPresentation).toBeUndefined();
        expect(finalDay.costFacts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'reported', amountUsd: 0.12 })]));
        if (earlierTokens === 100) {
            const priced = await querySession({ costMode: 'api_equivalent' });
            expect(priced.totals.cost.apiEquivalentUsd).toBeCloseTo(estimateUsageModelCost(modelId, assistant!.tokens)!.total, 10);
        }
    });
});
