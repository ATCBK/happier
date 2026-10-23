import { DEFAULT_PUBLIC_PROFILE_POLICY_V1, estimateUsageModelCost,
    normalizeUsageQuery, resolveUsagePageAggregation,
    UsageAnalyticsQueryRequestSchema, UsageEventIngestRequestSchema, usageQueryToAnalyticsRequest } from '@happier-dev/protocol';
import type { AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildPublicProfileSnapshot } from '@happier-dev/protocol/account/publicProfileSnapshot';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { buildClaudeAssistantUsageObservation } from '../../../../../packages/plugins/claude/src/agent/usage/buildAssistantObservation';
import { buildClaudeSdkResultUsageObservation } from '../../../../../packages/plugins/claude/src/agent/usage/buildSdkResultObservation';
import { buildUsageEventIngestRequest } from '../../../../cli/src/usage/buildUsageEventIngestRequest';
import { queryUsageAnalytics } from './usageQueryService';
import { recordUsageEvent } from './usageWriteService';
import { withCodexNativeAttachFixture } from '../../../../../packages/plugins/codex/src/agent/runtime/appServer/runtime.nativeAttach.test-support';
import { createNativeAgentSessionOperations } from '../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { withCodexDaemonMaterializedBootstrap } from '../../../../cli/src/daemon/connectedServices/materialize/codexDaemonBootstrap.testkit';
import { HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR, resolveExplicitSpawnScopedEnvironmentFromProcessEnv } from '../../../../cli/src/daemon/spawn/spawnExplicitEnvKeysMarker';
import { reconcileAgentSessionScopedEnvironment } from '../../../../cli/src/session/runtime/control/sessionControlEnvironment';

// Cross-package composition belongs in the existing composed integration lane,
// separate from the server-only compiler project and aggregation fixtures.
describe('native usage producer → ingest → query', () => {
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

    it.each([
        { planType: 'plus', delivery: 'concurrent', binding: 'bound' },
        { planType: 'team', delivery: 'concurrent', binding: 'bound' },
        { planType: 'future-plan', delivery: 'concurrent', binding: 'bound' },
        { planType: 'plus', delivery: 'reversed-same-clock', binding: 'bound' },
        { planType: 'plus', delivery: 'concurrent', binding: 'missing-session-ref' },
        { planType: 'plus', delivery: 'concurrent', binding: 'unbound' },
        { planType: 'plus', delivery: 'concurrent', binding: 'mismatched-native-account' },
        { planType: 'plus', delivery: 'concurrent', binding: 'caller-controls' },
        { planType: 'plus', delivery: 'concurrent', binding: 'daemon-without-bootstrap' },
    ])('reconciles exact Codex $planType responses through host admission and public preparation ($delivery, $binding)', async ({ planType, delivery, binding }) => {
        const account = await db.account.create({ data: { publicKey: `pk-codex-exact-${planType}` } });
        const session = await db.session.create({ data: { id: 'actual-happier-session', accountId: account.id,
            tag: `codex-exact-${planType}`, encryptionMode: 'plain', metadata: '{}' } });
        await withCodexDaemonMaterializedBootstrap({ sessionId: session.id, bound: binding !== 'unbound', run: async startup => {
        const connectedAccounts = binding === 'missing-session-ref' || binding === 'daemon-without-bootstrap'
            ? [] : startup.bootstrap.launch?.sessionConnectedAccounts ?? [];
        // The real daemon marks sanitized materializer output as explicit child
        // keys. Its ordinary CLI reader then reconciles that scope before host
        // construction; feeding materializer.env directly skipped this loss.
        const scoped = resolveExplicitSpawnScopedEnvironmentFromProcessEnv({ ...startup.environment,
            HAPPIER_HOME_DIR: 'caller-system-control-must-not-cross',
            [HAPPIER_SPAWN_EXPLICIT_ENV_KEYS_JSON_ENV_VAR]: JSON.stringify([...Object.keys(startup.environment), 'HAPPIER_HOME_DIR']),
        });
        const launchEnvironment = reconcileAgentSessionScopedEnvironment({ environment: scoped?.env ?? {},
            trustedDaemonTransport: binding !== 'caller-controls' && binding !== 'daemon-without-bootstrap',
        });
        expect(launchEnvironment.CODEX_HOME).toBe(startup.environment.CODEX_HOME);
        expect(launchEnvironment).not.toHaveProperty('HAPPIER_HOME_DIR');
        if (binding === 'caller-controls' || binding === 'daemon-without-bootstrap') {
            expect(launchEnvironment).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON');
            expect(launchEnvironment).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_TARGET_MATERIALIZED_ROOT');
            expect(launchEnvironment).not.toHaveProperty('HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON');
        }
        await withCodexNativeAttachFixture(async fixture => {
            const native = await fixture.openConfiguredSession();
            const writes: Array<ReturnType<typeof recordUsageEvent>> = [];
            const delayed: Array<NonNullable<ReturnType<typeof buildUsageEventIngestRequest>>> = [];
            let published = 0;
            let restoreSourceClock: (() => void) | undefined;
            const operations = createNativeAgentSessionOperations(native, session.id, undefined, undefined, {
                provider: 'codex',
                publish(input) {
                    const request = UsageEventIngestRequestSchema.parse(buildUsageEventIngestRequest({ ...input, sessionId: session.id }));
                    if (delivery === 'reversed-same-clock') delayed.push(request);
                    else writes.push(recordUsageEvent(account.id, request));
                    published++;
                },
            }, undefined, undefined, {
                // The host invocation services are the external process boundary;
                // native JSON-RPC, host event admission, accounting and DB stay real.
                context: { signal: new AbortController().signal } as AgentSessionRuntimeContext,
                cwd: fixture.directory, connectedAccounts, capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
                cancellation: { declared: false }, configuration: { declared: false }, manualCompaction: { declared: false },
            });
            const unsubscribe = operations.subscribeRuntimeEvents(() => undefined);
            try {
                await operations.sendTurnPrompt('two actual native response notifications', { turnId: 'host-turn', localId: 'input-1' });
                if (delivery === 'reversed-same-clock') {
                    // The provider clock and HTTP delivery are external boundaries.
                    // Hold one real source instant, then deliver the snapshot and
                    // duplicate ahead of the original response to expose the race.
                    const sourceClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
                    restoreSourceClock = () => sourceClock.mockRestore();
                }
                const usage = { totalTokens: 3, inputTokens: 2, outputTokens: 1 };
                for (const responseId of ['response-1', 'response-1', 'response-2']) {
                    fixture.emitNotification('rawResponse/completed', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
                        responseId, usage, usageMetadata: null, untrustedText: 'must-never-reach-usage' });
                }
                fixture.emitNotification('thread/tokenUsage/updated', { threadId: 'fresh-thread', turnId: 'provider-turn-1',
                    tokenUsage: { total: { totalTokens: 1006, inputTokens: 1004, outputTokens: 2 }, last: usage, modelContextWindow: 200_000 } });
                await expect.poll(() => published).toBe(4);
                restoreSourceClock?.();
                restoreSourceClock = undefined;
                if (delivery === 'reversed-same-clock') {
                    expect(new Set(delayed.map(request => request.observedAt)).size).toBe(1);
                    expect(await recordUsageEvent(account.id, delayed[3]!)).toMatchObject({ ok: true });
                    for (const result of await Promise.all([delayed[1]!, delayed[2]!].map(request => recordUsageEvent(account.id, request)))) {
                        expect(result).toMatchObject({ ok: true });
                    }
                    expect(await recordUsageEvent(account.id, delayed[0]!)).toMatchObject({ ok: true });
                }
                for (const result of await Promise.all(writes)) expect(result).toMatchObject({ ok: true });
                const privateResult = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({ filters: { sessionIds: [session.id] } }));
                const storedRows = await db.usageEvent.findMany({ where: { accountId: account.id }, select: {
                    id: true, source: true, scope: true, externalKey: true, observedAt: true, createdAt: true, totalTokens: true,
                } });
                expect(privateResult.totals.tokens.total, JSON.stringify({ storedRows, contributions: privateResult.contributions?.map(row => ({
                    id: row.id, source: row.source, turnId: row.turnId, tokens: row.tokens.total, observedAt: row.observedAtMs,
                })) })).toBe(1006);
                expect(privateResult.contributions?.filter(row => row.turnId === 'host-turn')).toHaveLength(2);
                expect(privateResult.contributions?.filter(row => row.source === 'codex-app-server-response-usage')
                    .every(row => row.providerAttribution === (binding === 'bound' ? 'known' : 'unknown')
                        && row.providerSource === (binding === 'bound' ? 'native' : 'unknown'))).toBe(true);
                expect(new Set(privateResult.contributions?.map(row => row.source))).toEqual(new Set([
                    'codex-app-server-response-usage', 'codex-app-server-token-usage',
                ]));
                const exactOnly = await queryUsageAnalytics(account.id, UsageAnalyticsQueryRequestSchema.parse({
                    filters: { sessionIds: [session.id], sources: ['codex-app-server-response-usage'] },
                }));
                expect(exactOnly.totals.tokens.total).toBe(6);
                expect(JSON.stringify(privateResult)).not.toContain('must-never-reach-usage');
                const endMs = Date.now() + 1;
                const query = normalizeUsageQuery({ population: 'public_eligible_personal', period: { startMs: endMs - 86_400_000, endMs },
                    session: [session.id], includeActivity: true });
                const publicResult = await queryUsageAnalytics(account.id, usageQueryToAnalyticsRequest(query, endMs));
                expect(publicResult.totals.tokens.total).toBe(planType === 'plus' && binding === 'bound' ? 6 : 0);
                if (planType === 'plus' && binding === 'bound') {
                    expect(publicResult.contributions).toHaveLength(2);
                    expect(publicResult.contributions?.every(row => row.providerAttribution === 'known' && row.turnId === 'host-turn')).toBe(true);
                    expect(publicResult.coverage?.sources.some(source => source.source === 'codex-app-server-response-usage'
                        && source.path === 'runtime' && source.status === 'partial' && typeof source.asOfMs === 'number')).toBe(true);
                    const queryResult = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available',
                        value: publicResult }] }).results[0]!;
                    expect(buildPublicProfileSnapshot({ queryResult, policy: DEFAULT_PUBLIC_PROFILE_POLICY_V1, nowMs: endMs }))
                        .toMatchObject({ kind: 'ready', snapshot: { facts: { tokens: 6 } } });
                } else expect(publicResult.contributions).toHaveLength(0);
            } finally {
                restoreSourceClock?.();
                unsubscribe();
                await operations.resetOrDisposeRuntime();
            }
        }, { sessionConnectedAccounts: connectedAccounts,
            processEnv: launchEnvironment,
            accountRead: () => ({ account: { type: 'chatgpt', email: null, planType }, workspaceRouting: {
                chatgptAccountId: binding === 'mismatched-native-account' ? 'contradictory-provider-account' : 'provider-account-A',
            } }),
            runtimeAuthHost: { nativeHome: startup.nativeHome },
        });
        } });
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
