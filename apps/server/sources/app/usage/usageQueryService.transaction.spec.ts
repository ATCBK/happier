import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryResponseSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { createDbMocks, createDbTransactionMock, installDbModuleMock, inTxPostgresControlStatementMock } from '@/app/api/testkit/dbMocks';
import { restoreEnv, snapshotEnv } from '@/testkit/env';
import type { ScopedUsageEventDbRow } from './query/scopedUsageEventRow';
import { homeConfigSnapshotPostgresQueryMock } from '@/app/home/settings/homeConfigSnapshot.testkit';

// Only the persistent database boundary is substituted. Transactions, retries,
// accounting, route registration and HTTP serialization all execute real code.
const boundary = createDbMocks({ usageEvent: ['findMany'], usageReport: ['findMany'],
    homeSettings: ['findUnique'], homeGovernancePolicy: ['findUnique'], simpleCache: ['findFirst'] });
const transactions = createDbTransactionMock(() => ({ ...boundary.db, ...inTxPostgresControlStatementMock, ...homeConfigSnapshotPostgresQueryMock }));
installDbModuleMock({ db: transactions.wrapDb(boundary.db) });
const { withAuthenticatedTestApp } = await import('@/app/api/testkit/sqliteFastify');
const { queryUsageAnalytics } = await import('./usageQueryService');
const { registerAccountUsageRoutes } = await import('@/app/api/routes/account/registerAccountUsageRoutes');

describe('Usage snapshot transaction lifetime', () => {
    const env = snapshotEnv();
    let committed = false;
    let attempt = 0;
    let retry = false;
    const projectionBeforeCommit: boolean[] = [];

    beforeEach(() => {
        process.env.HAPPIER_DB_PROVIDER = 'postgres';
        process.env.HAPPIER_DB_TX_RETRY_BASE_DELAY_MS = '0';
        process.env.HAPPIER_USAGE_MODEL_PRICE_FETCH_ENABLED = 'false';
        committed = false;
        attempt = 0;
        retry = false;
        projectionBeforeCommit.length = 0;
        boundary.db.homeSettings.findUnique.mockResolvedValue(null);
        boundary.db.homeGovernancePolicy.findUnique.mockResolvedValue(null);
        boundary.db.simpleCache.findFirst.mockResolvedValue(null);
        boundary.db.usageReport.findMany.mockResolvedValue([]);
        boundary.db.usageEvent.findMany.mockImplementation(async () => [{
            id: 'event', sessionId: null, observedAt: new Date(100), createdAt: new Date(100),
            agentId: 'codex', backendMode: null, modelId: null, projectKey: null, workspaceId: null,
            machineId: null, source: 'runtime', scope: 'turn_delta', isCumulative: false, turnId: 'turn',
            externalKey: null, requestCount: 1, teamCredentialResourceId: null, teamCredentialActorAccountId: null,
            teamCredentialExternalApiKeyId: null, teamCredentialSourceCredentialId: null, brokerMachineId: null,
            credentialDeliveryMode: null, inputTokens: attempt * 7, outputTokens: 0, reasoningTokens: 0,
            cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: attempt * 7, reportedCostUsd: 0,
            estimatedCostUsd: 0, invoiceCostUsd: 0, billingContext: null, costSource: null, currency: 'USD',
            costBreakdown: null, contextUsedTokens: null, contextWindowTokens: null,
            get metadata() { projectionBeforeCommit.push(!committed); return null; },
        } satisfies ScopedUsageEventDbRow]);
        transactions.transaction.mockImplementation(async (fn: (tx: object) => Promise<unknown>) => {
            attempt++;
            const result = await fn({ ...boundary.db, ...inTxPostgresControlStatementMock, ...homeConfigSnapshotPostgresQueryMock });
            if (retry && attempt === 1) throw Object.assign(new Error('Commit rolled back'), { code: 'P2034' });
            committed = true;
            return result;
        });
    });
    afterEach(() => { restoreEnv(env); boundary.reset(); });

    it('reconciles the captured rows only after their read transaction has committed', async () => {
        const response = await queryUsageAnalytics('account', UsageAnalyticsQueryRequestSchema.parse({ includeSeries: true }));
        expect(response.totals.tokens.total).toBe(7);
        expect(response.series?.[0]?.tokens.total).toBe(7);
        expect(projectionBeforeCommit.length).toBeGreaterThan(0);
        expect(projectionBeforeCommit).not.toContain(true);
    });

    it.each([true, false])('admits the public population only when its real capability is enabled (%s)', async enabled => {
        process.env.HAPPIER_FEATURE_ACCOUNT_PUBLIC_PROFILES__ENABLED = enabled ? '1' : '0';
        await withAuthenticatedTestApp(app => registerAccountUsageRoutes(app), async app => {
            const response = await app.inject({ method: 'POST', url: '/v2/usage/query',
                headers: { 'x-test-user-id': 'account' }, payload: { population: 'public_eligible_personal' } });
            expect(response.statusCode).toBe(enabled ? 200 : 404);
            if (enabled) {
                expect(UsageAnalyticsQueryResponseSchema.safeParse(response.json()).success).toBe(true);
                expect(committed).toBe(true);
            } else {
                expect(response.json()).toEqual({ error: 'not_found' });
            }
        });
    });

    it.each(['/v1/usage/query', '/v2/usage/query'])('replies from %s only after a successful retry commits', async url => {
        retry = true;
        const repliesBeforeCommit: boolean[] = [];
        await withAuthenticatedTestApp(app => {
            registerAccountUsageRoutes(app);
            app.addHook('onSend', async () => { repliesBeforeCommit.push(!committed); });
        }, async app => {
            const response = await app.inject({ method: 'POST', url, headers: { 'x-test-user-id': 'account' }, payload: {} });
            // An early HTTP response must not let teardown race a still-running retry.
            await vi.waitFor(() => expect(committed).toBe(true));
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(url.startsWith('/v1') ? body.usage[0].tokens.total : body.totals.tokens.total).toBe(14);
            expect(repliesBeforeCommit).toEqual([false]);
            expect(attempt).toBe(2);
        });
    });
});
