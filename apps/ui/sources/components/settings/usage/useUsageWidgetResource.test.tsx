import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook, renderScreen, standardCleanup, flushHookEffects, createDeferred } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { decodeUsageQueryResource, invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { normalizeUsageQuery, getUsageQueryKey, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { useUsageWidgetResource, useUsageWidgetBodyModel, type UsageWidgetResource, type UsageWidgetBodyModel } from './useUsageWidgetResource';
import type { UsageWidgetQueryPlan } from './usageWidgetQueries';

const accounting: UsageAnalyticsQueryResponse = { v: 1, totals: { eventCount: 1,
    tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' } } };
let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
function plan(query: UsageQuery): UsageWidgetQueryPlan {
    const row = { query, key: getUsageQueryKey(query), resolution: { status: 'ready' as const, input: { metric: query.metric } } };
    return { scope: { serverId: home!.homes.a!.id, accountId: 'account-a' },
        input: { queries: [query] }, widgets: new Map([['first', row], ['second', row]]) };
}
async function mountHome(route: Parameters<typeof serveAccountHomes>[0]['route']) {
    const sessionBoundary = createSessionReadBatchHttpBoundary(route);
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-widgets.test', accountId: 'account-a' }],
        route: sessionBoundary.handle });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    return (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
}
afterEach(async () => { standardCleanup(); retireActiveServerAccountScopeLifetime(); invalidateUsageQueryResources(); await home?.dispose(); home = undefined; });

function BodyProbe(props: Readonly<{ resource: UsageWidgetResource; instanceId: string;
    onModel: (instanceId: string, model: UsageWidgetBodyModel) => void }>) {
    const model = useUsageWidgetBodyModel(props.resource, props.instanceId);
    props.onModel(props.instanceId, model);
    return null;
}

describe('Usage widget shared Resource selection', () => {
    it('keeps a settled sibling body and its model work stable through another query progress, while forwarding its own activity and authority loss', async () => {
        const slowAccounting = createDeferred<Response>();
        const slowDetail = createDeferred<Response>();
        let detailIssued = false;
        let denied = false;
        const credentials = await mountHome(request => {
            if (request.path === '/v2/usage/query') {
                if (denied) return Response.json({ error: 'forbidden' }, { status: 403 });
                const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
                return query.filters?.sessionIds?.includes('slow-session') ? slowAccounting.promise : Response.json(accounting);
            }
            if (request.path === '/v2/sessions/slow-session') { detailIssued = true; return slowDetail.promise; }
            return undefined;
        });
        const first = normalizeUsageQuery({ session: 'settled-session', period: { startMs: 0, endMs: 1000 },
            includeSessionEvidence: false, includeWorkEvidence: false });
        const second = normalizeUsageQuery({ ...first, session: 'slow-session', includeSessionEvidence: true });
        const queryPlan = { ...plan(first), input: { queries: [first, second] }, widgets: new Map([
            ['first', plan(first).widgets.get('first')!], ['second', plan(second).widgets.get('second')!],
        ]) };
        const models = new Map<string, UsageWidgetBodyModel>();
        const computations = new Map<string, number>();
        const commits = new Map<string, number>();
        const onModel = (id: string, model: UsageWidgetBodyModel) => {
            models.set(id, model); computations.set(id, (computations.get(id) ?? 0) + 1);
        };
        const onRender: React.ProfilerOnRenderCallback = id => { commits.set(id, (commits.get(id) ?? 0) + 1); };
        function Page() {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return <>{['first', 'second'].map(id => <React.Profiler key={id} id={id} onRender={onRender}>
                <BodyProbe resource={resource} instanceId={id} onModel={onModel} />
            </React.Profiler>)}</>;
        }
        await renderScreen(<Page />);
        try {
            await expect.poll(() => models.get('first')?.slice?.accounting).toMatchObject(accounting);
            await flushHookEffects({ cycles: 20 });
            const settledSlice = models.get('first')!.slice;
            const baseline = { computations: computations.get('first'), commits: commits.get('first') };
            const secondComputations = computations.get('second')!;
            const withDetail: UsageAnalyticsQueryResponse = { ...accounting, contributions: [{ id: 'fact', observedAtMs: 500,
                sessionId: 'slow-session', turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null,
                workspaceId: null, source: null, tokens: accounting.totals.tokens, cost: accounting.totals.cost }] };
            await act(async () => { slowAccounting.resolve(Response.json(withDetail)); });
            await expect.poll(() => detailIssued).toBe(true);
            await expect.poll(() => models.get('second')?.slice?.accounting).toMatchObject(withDetail);
            await flushHookEffects({ cycles: 20 });
            expect(models.get('first')!.slice).toBe(settledSlice);
            expect(computations.get('first')).toBe(baseline.computations);
            expect(commits.get('first')).toBe(baseline.commits);
            expect(computations.get('second')).toBeGreaterThan(secondComputations);
            expect(models.get('second')!.pending).toBe(true);
            expect(models.get('second')!.refreshing).toBe(false);
            await act(async () => { slowDetail.resolve(Response.json({ error: 'not_found' }, { status: 404 })); });
            await expect.poll(() => models.get('second')!.pending).toBe(false);
            expect(models.get('first')!.pending).toBe(false);
            denied = true;
            await act(async () => { await models.get('first')!.refresh(); });
            await flushHookEffects({ cycles: 20 });
            for (const model of models.values()) {
                expect(model.slice).toBeNull();
                expect(model.shownQuery).toBeNull();
                expect(model.error).toBeTruthy();
            }
        } finally {
            slowAccounting.resolve(Response.json(accounting));
            slowDetail.resolve(Response.json({ error: 'not_found' }, { status: 404 }));
        }
    });
    it('exposes source-only initial progress to page chrome while bodies retain their first-read placeholder', async () => {
        const held = createDeferred<Response>();
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held.promise.then(response => response.clone()) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, includeSessionEvidence: true, includeWorkEvidence: false }));
        const hook = await renderHook(() => {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return { resource, model: useUsageWidgetBodyModel(resource, 'first') };
        });
        try {
            await expect.poll(() => hook.getCurrent().resource.entry?.getSnapshot().value !== undefined).toBe(true);
            const content = hook.getCurrent().resource.entry!.getSnapshot().value!;
            expect(decodeUsageQueryResource(content).results[0]?.sources).toEqual(expect.arrayContaining([
                { source: 'accounting', status: 'pending' }, { source: 'how_you_work', status: 'pending' },
            ]));
            expect(hook.getCurrent().model.slice).toBeNull();
            expect(hook.getCurrent().model.pending).toBe(true);
            await act(async () => { held.resolve(Response.json(accounting)); });
            await flushHookEffects({ cycles: 30 });
            expect(hook.getCurrent().model.slice?.accounting?.totals).toEqual(accounting.totals);
        } finally { held.resolve(Response.json(accounting)); }
    });
    it('does not relabel a foreign Account query intent as the current Account read', async () => {
        const credentials = await mountHome(request => request.path === '/v2/usage/query' ? Response.json(accounting) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, granularity: 'day' }));
        const foreign = { ...queryPlan, scope: { ...queryPlan.scope, accountId: 'account-b' } };
        const hook = await renderHook(() => useUsageWidgetBodyModel(
            useUsageWidgetResource({ credentials, enabled: true, plan: foreign }), 'first'),
        { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().slice).toBeNull();
        expect(hook.getCurrent().requestedQuery).toBeNull();
    });

    it('shares the exact slice between widget bodies and removes it on Home authority refusal', async () => {
        let denied = false;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? denied ? Response.json({ error: 'forbidden' }, { status: 403 }) : Response.json(accounting) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, granularity: 'day' }));
        const hook = await renderHook(() => {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return { first: useUsageWidgetBodyModel(resource, 'first'), second: useUsageWidgetBodyModel(resource, 'second') };
        }, { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().first.slice?.accounting).toMatchObject(accounting);
        expect(hook.getCurrent().second.slice).toBe(hook.getCurrent().first.slice);
        denied = true;
        await act(async () => { await hook.getCurrent().first.refresh(); });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().first.slice).toBeNull();
        expect(hook.getCurrent().first.shownQuery).toBeNull();
        expect(hook.getCurrent().first.error).toBeTruthy();
    });

    it('shows a named previous period only, drops a basis change, and ignores late completion after retirement', async () => {
        const delayed = createDeferred<Response>();
        let held = false;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held ? delayed.promise : Response.json(accounting) : undefined);
        const hook = await renderHook(({ startMs, costBasis }: { startMs: number; costBasis: 'auto' | 'reported' }) => {
            const resource = useUsageWidgetResource({ credentials, enabled: true,
                plan: plan(normalizeUsageQuery({ period: { startMs }, granularity: 'day', costBasis })) });
            return useUsageWidgetBodyModel(resource, 'first');
        }, { initialProps: { startMs: 1000, costBasis: 'auto' }, flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().slice?.accounting).toMatchObject(accounting);
        held = true;
        await hook.rerender({ startMs: 2000, costBasis: 'auto' });
        expect(hook.getCurrent().updatingPreviousPeriod).toBe(true);
        expect(hook.getCurrent().shownQuery?.query.period).toEqual({ startMs: 1000 });
        expect(hook.getCurrent().requestedQuery?.query.period).toEqual({ startMs: 2000 });
        await hook.rerender({ startMs: 2000, costBasis: 'reported' });
        expect(hook.getCurrent().slice).toBeNull();
        await act(async () => { publishAppliedActiveServerRuntimeAvailability(false); delayed.resolve(Response.json(accounting)); });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().slice).toBeNull();
        expect(hook.getCurrent().requestedQuery).toBeNull();
    });

    it('says shown facts are being re-read only while their own read is in flight, not while another source is outstanding', async () => {
        const delayed = createDeferred<Response>();
        let held = false;
        const credentials = await mountHome(request => request.path === '/v2/usage/query'
            ? held ? delayed.promise : Response.json(accounting) : undefined);
        const queryPlan = plan(normalizeUsageQuery({ period: { startMs: 1000 }, granularity: 'day' }));
        const hook = await renderHook(() => useUsageWidgetBodyModel(
            useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan }), 'first'),
        { flushOptions: { cycles: 20 } });
        expect(hook.getCurrent().slice?.accounting).toMatchObject(accounting);
        // Quota, Work and How-you-work have no producer in this Home: their state belongs to their own lines.
        expect(hook.getCurrent().refreshing).toBe(false);
        held = true;
        let refreshed: Promise<void> | undefined;
        await act(async () => { refreshed = hook.getCurrent().refresh(); });
        await flushHookEffects({ cycles: 5 });
        expect(hook.getCurrent().slice?.accounting).toMatchObject(accounting);
        expect(hook.getCurrent().refreshing).toBe(true);
        await act(async () => { delayed.resolve(Response.json(accounting)); await refreshed; });
        await flushHookEffects({ cycles: 20 });
        expect(hook.getCurrent().refreshing).toBe(false);
    });

    it('releases accounting activity while slow private detail is still being read', async () => {
        const detail = createDeferred<Response>();
        let issued = false;
        const withDetail: UsageAnalyticsQueryResponse = { ...accounting, contributions: [{ id: 'fact', observedAtMs: 500,
            sessionId: 'slow-session', turnId: 'turn', agentId: null, modelId: null, machineId: null, projectKey: null,
            workspaceId: null, source: null, tokens: accounting.totals.tokens, cost: accounting.totals.cost }] };
        const credentials = await mountHome(request => {
            if (request.path === '/v2/usage/query') return Response.json(withDetail);
            if (request.path === '/v2/sessions/slow-session') { issued = true; return detail.promise; }
            return undefined;
        });
        const queryPlan = plan(normalizeUsageQuery({ session: 'slow-session', period: { startMs: 0, endMs: 1000 } }));
        const hook = await renderHook(() => {
            const resource = useUsageWidgetResource({ credentials, enabled: true, plan: queryPlan });
            return { ...useUsageWidgetBodyModel(resource, 'first'), entry: resource.entry };
        },
        { flushOptions: { cycles: 30 } });
        const settled = createDeferred<void>();
        const entry = hook.getCurrent().entry!;
        const release = entry.subscribe(() => { if (entry.getSnapshot().pending === 'idle') settled.resolve(); }, false);
        try {
            await expect.poll(() => issued).toBe(true);
            expect(hook.getCurrent().slice?.accounting).toMatchObject(withDetail);
            expect(hook.getCurrent().pending).toBe(true);
            expect(hook.getCurrent().refreshing).toBe(false);
            await act(async () => { detail.resolve(Response.json({ error: 'not_found' }, { status: 404 })); await settled.promise; });
            await flushHookEffects({ cycles: 30 });
            expect(entry.getSnapshot().pending).toBe('idle');
            expect(hook.getCurrent().slice?.sources.find(source => source.source === 'how_you_work')?.status).not.toBe('pending');
            expect(hook.getCurrent().refreshing).toBe(false);
        } finally { release(); detail.resolve(Response.json({ error: 'not_found' }, { status: 404 })); }
    });
});
