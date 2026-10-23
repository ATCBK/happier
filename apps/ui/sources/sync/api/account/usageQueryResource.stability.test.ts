import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import * as strictJson from '@happier-dev/protocol/json/strictJsonValue';
import { afterEach, expect, it, vi } from 'vitest';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { standardCleanup } from '@/dev/testkit';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getUsageQueryKey, normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { captureUiUsageQueryAccountContext, decodeUsageQueryResource, getUsageQueryResourceStore } from './usageQueryResource';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { storage } from '@/sync/domains/state/storage';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import * as usageCost from '@happier-dev/protocol/usage/usageCost';
import { bundledUsageModelPriceCatalog } from '@happier-dev/protocol/usage/usageModelPriceCatalog';
import { readUiUsageQueryBatch } from './usageQueryResource';
import { computePluginUiArtifactSha256Digest } from '@/sync/domains/plugins/ui/artifactIntegrity';
import * as platformDigest from '@/platform/digest';
import { UsageQueryBatchResultSchema } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { describeUsagePagePendingSources, readUsagePageAsOfMs } from '@/components/settings/usage/widgets/usageBodyKit';

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
    standardCleanup();
    retireActiveServerAccountScopeLifetime();
    await home?.dispose();
    home = undefined;
    vi.restoreAllMocks();
});

it('reuses contribution references across equal refetches without whole-population equality', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const cost = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' };
    const population = Array.from({ length: 3600 }, (_, index) => ({ id: String(index), observedAtMs: 1500,
        sessionId: null, turnId: null, agentId: null, modelId: null, machineId: null, projectKey: null,
        workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost }));
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-equal-refetch.test', accountId: 'account-a' }],
        route: request => request.path === '/v2/usage/query' ? Response.json({ v: 1,
            totals: { eventCount: population.length, tokens, cost }, contributions: population }) : undefined });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!)!;
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const query = normalizeUsageQuery({ period: { relative: 'all' }, includeSessionEvidence: false,
        includeWorkEvidence: false, includeActivity: false, includeModelTimeline: false });
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query',
        input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const stop = entry.subscribe(() => {}, false);
    try {
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        const before = decodeUsageQueryResource(entry.getSnapshot().value!);
        const compare = vi.spyOn(strictJson, 'sameStrictJsonValue'); // Observe real comparisons; no internal logic is replaced.
        for (let index = 0; index < 3; index++) await entry.refresh();
        const after = decodeUsageQueryResource(entry.getSnapshot().value!);
        expect(after.results[0]?.accounting).toBe(before.results[0]?.accounting);
        const walks = compare.mock.calls.filter(([value]) => Array.isArray(value) && value.length === population.length);
        expect(walks.length, 'fresh rows are reconciled once at producer admission, never as a whole-population member').toBe(0);
        expect(compare.mock.calls.filter(([value]) => value && typeof value === 'object'
            && 'shownQuery' in value && 'sources' in value).length,
            'the existing Resource digest replaces settled-slice deep equality').toBe(0);
    } finally { stop(); }
});

it('keeps completed source dates and a quiet header while the same query rereads in the background', async () => {
    const held = createDeferred<void>();
    let hold = false;
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-header-refresh.test', accountId: 'account-a' }],
        route: async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            if (hold) await held.promise;
            return Response.json({ v: 1, totals: { eventCount: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } } });
        } });
    const server = home.homes.a!;
    publishAppliedActiveServerSnapshot({ serverId: server.id, serverUrl: server.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(server.serverUrl))!)!;
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 } });
    const input = { queries: [query] };
    const settled = await readUiUsageQueryBatch(captured, input);
    const asOf = readUsagePageAsOfMs(settled.results);
    expect(asOf).not.toBeNull();
    hold = true;
    const progress = createDeferred<void>();
    let shown = settled;
    const reading = readUiUsageQueryBatch(captured, input, undefined, settled, { onProgress: batch => {
        shown = batch;
        progress.resolve();
    } });
    try {
        await progress.promise;
        expect(shown.results[0]?.pending).toBe(true);
        expect.soft(readUsagePageAsOfMs(shown.results)).toBe(asOf);
        expect.soft(describeUsagePagePendingSources(shown.results)).toBeNull();
        expect.soft(shown.results[0]?.sources.find(source => source.source === 'how_you_work')?.asOfMs)
            .toBe(settled.results[0]?.sources.find(source => source.source === 'how_you_work')?.asOfMs);
    } finally { held.resolve(); await reading; }
});

it('preserves exact Resource bytes and digest without scalar UTF-8 calls while independent source phases advance', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    const sibling = createDeferred<void>();
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-serialization.test', accountId: 'account-a' }],
        route: async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            const slow = UsageAnalyticsQueryRequestSchema.parse(request.body).filters?.agentIds?.includes('slow');
            if (slow) await sibling.promise;
            return Response.json({ v: 1,
            totals: { eventCount: 1, tokens, cost }, contributions: slow ? [] : [{ id: 'serialization-evidence-λ', observedAtMs: 1500,
                sessionId: null, turnId: null, agentId: null, modelId: null, machineId: null, projectKey: null,
                workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost }] });
        } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!)!;
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    // The UTF-8 boundary measures repeated whole-payload work without replacing
    // any internal query, projection, or serialization behavior.
    const encodeInto = vi.spyOn(TextEncoder.prototype, 'encodeInto');
    // Call through the real schema; a native typed producer's final revision
    // must not clone the entire population after progressive admission.
    const readmission = vi.spyOn(UsageQueryBatchResultSchema, 'safeParse');
    const entry = getUsageQueryResourceStore(captured).getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({
        queries: ['first', 'slow'].map(agent => normalizeUsageQuery({ period: { relative: 'all' }, agents: [agent], includeWorkEvidence: false })),
    }) });
    const release = entry.subscribe(() => {}, false);
    try {
        await expect.poll(() => {
            const content = entry.getSnapshot().value;
            return content && decodeUsageQueryResource(content).results[0]?.accounting !== undefined;
        }).toBe(true);
        sibling.resolve();
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        const content = entry.getSnapshot().value!;
        expect(JSON.parse(new TextDecoder().decode(content.bytes))).toEqual(JSON.parse(JSON.stringify(decodeUsageQueryResource(content))));
        expect(content.digest).toBe(await computePluginUiArtifactSha256Digest(content.bytes));
        expect(decodeUsageQueryResource(content).results[0]?.accounting?.contributions?.[0]?.id).toBe('serialization-evidence-λ');
        expect(encodeInto.mock.calls.length, 'Resource encoding must not call UTF-8 per scalar/key').toBe(0);
        expect(readmission.mock.calls.reduce((count, [value]) => count +
            (typeof value === 'object' && value !== null && 'results' in value ? 1 : 0), 0)).toBe(0);
    } finally { sibling.resolve(); release(); }
});

it('reprices shared accounting once per tariff across sibling evidence queries and progressive publications', async () => {
    const query = normalizeUsageQuery({ period: { startMs: 1000 }, includeSessionEvidence: false, includeWorkEvidence: false,
        includeActivity: false, includeSeries: false });
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 };
    const cost = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' };
    let count = 3600;
    let rate = 2;
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-pricing-inputs.test', accountId: 'account-a' }],
        route: request => request.path === '/v2/usage/query' ? Response.json({ v: 1,
            totals: { eventCount: count, tokens: { ...tokens, input: 10 * count, output: 5 * count, total: 15 * count }, cost },
            priceCatalog: { ...bundledUsageModelPriceCatalog, models: { model: { inputUsdPerMillion: rate, outputUsdPerMillion: 1 } } },
            contributions: Array.from({ length: count }, (_, index) => ({ id: String(index), observedAtMs: 1500,
                sessionId: null, turnId: null, agentId: null, modelId: 'model', machineId: null, projectKey: null,
                workspaceId: null, source: null, eventCount: 1, tokens, tokenCategories: tokens, cost })) }) : undefined });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const captured = captureUiUsageQueryAccountContext((await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!)!;
    storage.setState({ profileScope: captured.accountLifetime.scope, profile: AccountProfileSchema.parse({ id: 'account-a' }) });
    const reprice = vi.spyOn(usageCost, 'repriceUsageAnalyticsResponse');
    for (const change of ['initial', 'contribution', 'price'] as const) {
        if (change === 'contribution') count++;
        if (change === 'price') rate++;
        reprice.mockClear();
        const progress: number[] = [];
        const started = performance.now();
        const result = await readUiUsageQueryBatch(captured, { queries: [query,
            normalizeUsageQuery({ ...query, includeTranscriptEvidence: !query.includeTranscriptEvidence })] }, undefined, undefined,
            { onProgress: batch => { if (batch.results[0]?.accounting) progress.push(batch.results[0].accounting.contributions!.length); } });
        const elapsedMs = performance.now() - started;
        expect(progress.length).toBeGreaterThan(0);
        expect(result.results[0]!.accounting!.contributions).toHaveLength(count);
        expect(result.results[0]!.accounting!.totals.cost.apiEquivalentUsd).toBeCloseTo(count * (10 * rate + 5) / 1_000_000);
        expect(result.results[1]!.accounting).toBe(result.results[0]!.accounting);
        console.log('[USAGE-AGG-IDLE]', JSON.stringify({ change, contributions: count, elapsedMs, repricingRuns: reprice.mock.calls.length }));
        expect(reprice, `${change} accounting must be priced once across all publications`).toHaveBeenCalledTimes(1);
    }
});

it('seeds the same accounting query from its Account facts when a route mounts a different batch', async () => {
    const pending = createDeferred<void>();
    let hold = false;
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-batch-retention.test', accountId: 'account-a' }],
        route: async request => {
            if (request.path !== '/v2/usage/query') return undefined;
            if (hold) await pending.promise;
            return Response.json({ v: 1, totals: { eventCount: 1,
                tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
                cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
                series: [{ bucketStartMs: 1000, bucketEndMs: 2000, eventCount: 1,
                    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
                    cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } }] });
        } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const captured = captureUiUsageQueryAccountContext(credentials)!;
    storage.setState({ profileScope: captured.accountLifetime.scope,
        profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const query = normalizeUsageQuery({ period: { startMs: 1000, endMs: 2000 }, includeWorkEvidence: false, includeSessionEvidence: false });
    const store = getUsageQueryResourceStore(captured);
    const initial = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query] }) });
    const release = initial.subscribe(() => {}, false);
    await expect.poll(() => initial.getSnapshot().pending).toBe('idle');
    const before = decodeUsageQueryResource(initial.getSnapshot().value!).results[0]!.accounting;
    release();
    hold = true;
    const returning = store.getEntry({ hostRead: 'usage.query', input: projectNativeJsonValueForTransport({ queries: [query,
        normalizeUsageQuery({ ...query, agents: ['claude'] })] }) });
    const stop = returning.subscribe(() => {}, false);
    try {
        await expect.poll(() => returning.getSnapshot().value !== undefined).toBe(true);
        const shown = decodeUsageQueryResource(returning.getSnapshot().value!).results.find(slice => slice.key === getUsageQueryKey(query))!;
        expect(shown.accounting).toEqual(before);
        expect(shown.sources.find(source => source.source === 'accounting')?.status).toBe('pending');
        expect(decodeUsageQueryResource(returning.getSnapshot().value!).results.find(slice => slice.key !== getUsageQueryKey(query))?.accounting,
            'a differently filtered query cannot inherit these facts').toBeUndefined();
    } finally { pending.resolve(); stop(); }
});

it('preserves an unchanged batched slice across Resource revisions without sharing it across retired authority', async () => {
    // This is the clock boundary, so unchanged observed source currentness is
    // distinguishable from a real change to one query's accounting facts.
    vi.spyOn(Date, 'now').mockReturnValue(1_900_000_000_000);
    let changedCount = 1;
    const accounting = (eventCount: number): UsageAnalyticsQueryResponse => ({ v: 1, totals: {
        eventCount, tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
        cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' },
    } });
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-stability.test', accountId: 'account-a' }],
        route: request => {
            if (request.path !== '/v2/usage/query') return undefined;
            const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
            return Response.json(accounting(query.filters?.agentIds?.includes('claude') ? changedCount : 1));
        } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    const queries = ['claude', 'codex'].map(agent => normalizeUsageQuery({
        period: { startMs: 1000, endMs: 2000 }, agents: [agent],
    }));
    const reference = { hostRead: 'usage.query' as const, input: projectNativeJsonValueForTransport({ queries }) };
    const captured = captureUiUsageQueryAccountContext(credentials);
    if (!captured) throw new Error('Expected admitted Account');
    // Match the served Home before subscribing: its asynchronous bootstrap
    // must not turn unknown profile scope into new source state mid-comparison.
    storage.setState({ profileScope: captured.accountLifetime.scope,
        profile: AccountProfileSchema.parse({ id: captured.accountLifetime.scope.accountId }) });
    const entry = getUsageQueryResourceStore(captured).getEntry(reference);
    const release = entry.subscribe(() => {}, false);
    const readReady = async () => {
        await expect.poll(() => {
            const content = entry.getSnapshot().value;
            return content !== undefined && decodeUsageQueryResource(content).results.every(slice =>
                slice.sources.some(source => source.source === 'how_you_work' && source.status !== 'pending'));
        }).toBe(true);
        return decodeUsageQueryResource(entry.getSnapshot().value!);
    };
    try {
        const before = await readReady();
        const firstKey = getUsageQueryKey(queries[0]);
        const siblingKey = getUsageQueryKey(queries[1]);
        const beforeFirst = before.results.find(slice => slice.key === firstKey)!;
        const beforeSibling = before.results.find(slice => slice.key === siblingKey)!;
        await expect.poll(() => entry.getSnapshot().pending).toBe('idle');
        const digest = vi.spyOn(platformDigest, 'digest');
        changedCount = 2;
        await entry.refresh();
        const after = await readReady();
        expect(after.results.find(slice => slice.key === firstKey)?.accounting?.totals.eventCount).toBe(2);
        expect(after.results.find(slice => slice.key === firstKey)).not.toBe(beforeFirst);
        expect(after.results.find(slice => slice.key === siblingKey)).toBe(beforeSibling);
        const digested = digest.mock.calls.map(([, bytes]) => new TextDecoder().decode(bytes))
            .filter(text => text.startsWith('{"v":1,"results":['));
        expect(digested.length).toBeGreaterThan(0);
        expect(digested.filter((text, index) => index > 0 && text === digested[index - 1]).length,
            'an unchanged admitted revision must not encode/hash its whole bytes again').toBe(0);

        retireActiveServerAccountScopeLifetime();
        expect(entry.getSnapshot().value).toBeUndefined();
        const replacement = captureUiUsageQueryAccountContext(credentials);
        if (!replacement) throw new Error('Expected replacement admitted Account');
        expect(replacement.accountLifetime).not.toBe(captured.accountLifetime);
        const replacementEntry = getUsageQueryResourceStore(replacement).getEntry(reference);
        const stopReplacement = replacementEntry.subscribe(() => {}, false);
        try {
            await replacementEntry.refresh();
            const content = replacementEntry.getSnapshot().value;
            expect(content).toBeDefined();
            expect(decodeUsageQueryResource(content!).results.find(slice => slice.key === siblingKey)).not.toBe(beforeSibling);
        } finally { stopReplacement(); }
    } finally { release(); }
});
