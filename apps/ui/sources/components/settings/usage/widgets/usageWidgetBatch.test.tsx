import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { UsageAnalyticsQueryRequestSchema, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { renderScreen, standardCleanup, flushHookEffects } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { invalidateUsageQueryResources } from '@/sync/api/account/usageQueryResource';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import {
  UsageWidgetBatchProvider,
  useUsageWidgetBatchSlices,
  useUsageWidgetModel,
  buildUsageWidgetQueryPlan,
} from './usageWidgetBatch';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { readUsageWidgetQueryOverrides, resolveUsageWidgetPageInitialQuery } from '../usageWidgetPageContext';
import { resolveUsagePageInitialFilters } from '../usageRouteParams';
import { buildUsageAnalyticsViewModel } from '@/sync/api/account/usageAnalytics';
import { UsageWidgetBody } from './UsageWidgetBody';
import { storage } from '@/sync/domains/state/storage';
import { createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';

const accounting: UsageAnalyticsQueryResponse = {
  v: 1,
  totals: {
    eventCount: 1,
    tokens: {
      input: 10,
      output: 5,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 15,
    },
    cost: { reportedUsd: 1, estimatedUsd: 0, currency: 'USD' },
  },
};
const scope = {
  period: { startMs: 1000 },
  agents: [],
  machines: [],
  projects: [],
  sources: [],
  session: null,
  costBasis: 'auto',
} as const;
const clauses = readUsageWidgetQueryOverrides(normalizeUsageQuery({ granularity: 'day', timeZoneOffsetMinutes: 0 }));

let home: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
afterEach(async () => {
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  invalidateUsageQueryResources();
  await home?.dispose();
  home = undefined;
});

/** The page chrome's view of the batch: one decoded Resource value for every mounted body. */
function BatchProbe(props: Readonly<{ batches: string[][] }>) {
  props.batches.push(useUsageWidgetBatchSlices().map((slice) => slice.key));
  return null;
}

function Body(
  props: Readonly<{
    name: string;
    metric: 'tokens' | 'cost';
    seen: Map<string, UsageWidgetBodyModel>;
  }>,
) {
  const { model } = useUsageWidgetModel({
    ...scope,
    metric: props.metric,
    breakdown: [],
  }, 'usage_daily');
  props.seen.set(props.name, model);
  return null;
}

describe('Usage page batch', () => {
  it.each(['usage_daily', 'usage_outcomes', 'usage_footprint'] as const)('admits private evidence through the real %s body only when its projection consumes it', async narrowId => {
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-widget-demand.test', accountId: 'account-a' }],
      route: request => {
        if (request.path === '/v2/usage/query') return Response.json(accounting);
        if (request.path === '/v1/account/encryption/currentness') return Response.json({ mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
        if (request.path === '/v2/sessions/work') return Response.json({ session: { id: 'work',
          createdAt: 1, updatedAt: 900, seq: 1, active: true, activeAt: 900,
          encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
          metadataVersion: 1, metadata: JSON.stringify({ name: 'work' }), agentStateVersion: 1,
          agentState: null, share: null, effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
            capabilities: createSessionAccessFixture().capabilities }, responsibleAccountId: null, responsibleAccount: null } });
        if (request.path === '/v1/sessions/work/turns') return Response.json({ v: 1, sessionId: 'work', updatedAt: 900,
          turns: [{ turnId: 'turn', agentId: 'codex', status: 'completed', startedAt: 100, terminalAt: 400, updatedAt: 900 }] });
        if (request.path === '/v1/sessions/work/messages') return Response.json({ messages: [], hasMore: false });
        return undefined;
      } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    storage.setState({ profileScope: { serverId: home.homes.a!.id, accountId: 'account-a' },
      profile: AccountProfileSchema.parse({ id: 'account-a' }),
      sessions: { work: createSessionFixture({ id: 'work', serverId: home.homes.a!.id, encryptionMode: 'plain' }) } });
    const body = (id: typeof narrowId | 'usage_period_summary') => <InjectedAuthProvider credentials={credentials}>
      <CoreCollectionScope><UsageWidgetBatchProvider clauses={clauses}><UsageWidgetBody id={id}
        input={{ ...scope, period: { startMs: 0, endMs: 1000 }, metric: 'tokens', breakdown: [] }}
        serverId={home!.homes.a!.id} testID="widget-demand" /></UsageWidgetBatchProvider></CoreCollectionScope>
    </InjectedAuthProvider>;
    const screen = await renderScreen(body(narrowId));
    await expect.poll(() => home!.requests.filter(request => request.path === '/v2/usage/query').length).toBeGreaterThan(0);
    await flushHookEffects({ cycles: 30 });
    expect(home.requests.filter(request => /\/sessions\//.test(request.path))).toEqual([]);
    await screen.update(body('usage_period_summary'));
    await expect.poll(() => home!.requests.filter(request => request.path === '/v1/sessions/work/messages').length).toBe(1);
    await flushHookEffects({ cycles: 30 });
    expect(home.requests.filter(request => request.path === '/v2/sessions/work')).toHaveLength(1);
  });

  it.each([false, true])('requests both consumed activity sections despite route includeActivity=%s and partial resolution, preserving independently pinned scope', async includeActivity => {
    const days = [{ date: '2026-10-08', eventCount: 1 }, { date: '2026-10-09', eventCount: 2 }, { date: '2026-10-10', eventCount: 1 }];
    const page = resolveUsageWidgetPageInitialQuery({ nowMs: Date.UTC(2026, 9, 11), timeZoneOffsetMinutes: 120,
      initialFilters: resolveUsagePageInitialFilters({ queryOverrides: JSON.stringify(readUsageWidgetQueryOverrides(normalizeUsageQuery({ includeActivity, activityResolution: 'weekdayHour' }))) }) });
    const input = { ...scope, period: { startMs: Date.UTC(2026, 9, 8), endMs: Date.UTC(2026, 9, 11) }, machines: ['pinned'], metric: 'tokens' as const, breakdown: [] };
    home = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-activity.test', accountId: 'account-a' }], route: request => {
      if (request.path !== '/v2/usage/query') return undefined;
      const query = UsageAnalyticsQueryRequestSchema.parse(request.body);
      return Response.json({ ...accounting, insights: { activeDays: 3, longestStreakDays: 3, sessionsUsed: 1,
        messagesUsed: 4, modelsTried: 0, favoriteModelChangeCount: 0 }, series: days.map((day, index) => ({ bucketStartMs: input.period.startMs + index * 86_400_000,
        bucketEndMs: input.period.startMs + (index + 1) * 86_400_000, eventCount: day.eventCount,
        tokens: accounting.totals.tokens, cost: accounting.totals.cost })), activity: query.includeActivity ? {
        calendarDays: query.activityResolution === 'weekdayHour' ? undefined : days,
        weekdayHourBuckets: query.activityResolution === 'calendar' ? undefined : [{ weekday: 4, hour: 12, eventCount: 4 }],
      } : undefined });
    } });
    publishAppliedActiveServerSnapshot({ serverId: home.homes.a!.id, serverUrl: home.homes.a!.serverUrl, generation: 0 });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(home.homes.a!.serverUrl))!;
    let observed: ReturnType<typeof useUsageWidgetModel> | undefined;
    function Probe() { observed = useUsageWidgetModel(input, 'usage_daily'); return null; }
    await renderScreen(<InjectedAuthProvider credentials={credentials}><UsageWidgetBatchProvider clauses={readUsageWidgetQueryOverrides(page)}>
      <Probe />
    </UsageWidgetBatchProvider></InjectedAuthProvider>);
    await flushHookEffects({ cycles: 30 });
    expect(observed?.query).toMatchObject({ includeActivity: true, activityResolution: 'both', includeSessionEvidence: false,
      machines: ['pinned'], period: input.period });
    expect(observed?.model.slice?.accounting?.activity).toEqual({ calendarDays: days,
      weekdayHourBuckets: [{ weekday: 4, hour: 12, eventCount: 4 }] });
    const view = buildUsageAnalyticsViewModel(observed!.model.slice!.accounting!, { period: 'all', metric: 'tokens', costMode: 'auto', focus: null });
    expect(view.overview.activeDays).toBe(view.activity.calendarDays.length);
    expect(view.overview.activeDays).toBe(3);
    expect(view.insights.activeDays).toBe(view.activity.calendarDays.length);
    expect(view.insights.activeDays).toBe(3);
  });
  it('keeps the period-qualified unfiltered scope inventory in the same batch as narrowed widgets', () => {
    const query = normalizeUsageQuery({ ...scope, agents: ['claude'], sources: ['runtime'], breakdown: ['model'] });
    const inventory = normalizeUsageQuery({ ...query, agents: [], sources: [], machines: [], projects: [], breakdown: ['agent', 'machine', 'project', 'source'] });
    const plan = buildUsageWidgetQueryPlan({ serverId: 'home', accountId: 'account' }, new Map(), inventory);
    expect(plan.input?.queries).toEqual([inventory]);
    expect(plan.widgets.size).toBe(0);
  });
  it('serves every mounted body from one batched read: equal queries share a slice, distinct ones stay keyed apart', async () => {
    const batches: string[][] = [];
    home = await serveAccountHomes({
      homes: [
        {
          key: 'a',
          serverUrl: 'https://usage-batch.test',
          accountId: 'account-a',
        },
      ],
      route: (request) => {
        if (request.path !== '/v2/usage/query') return undefined;
        return Response.json(accounting);
      },
    });
    publishAppliedActiveServerSnapshot({
      serverId: home.homes.a!.id,
      serverUrl: home.homes.a!.serverUrl,
      generation: 0,
    });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = (await TokenStorage.getCredentialsForServerUrl(
      home.homes.a!.serverUrl,
    ))!;
    const seen = new Map<string, UsageWidgetBodyModel>();
    await renderScreen(
      <InjectedAuthProvider credentials={credentials}>
        <UsageWidgetBatchProvider clauses={clauses as never}>
          <Body name="daily" metric="tokens" seen={seen} />
          <Body name="summary" metric="tokens" seen={seen} />
          <Body name="costs" metric="cost" seen={seen} />
          <BatchProbe batches={batches} />
        </UsageWidgetBatchProvider>
      </InjectedAuthProvider>,
    );
    await flushHookEffects({ cycles: 30 });
    const daily = seen.get('daily')!;
    const summary = seen.get('summary')!;
    const costs = seen.get('costs')!;
    expect(daily.slice?.accounting?.totals.tokens.total).toBe(15);
    // Equal resolved requests are one keyed slice; a different own metric is its own slice.
    expect(summary.slice).toBe(daily.slice);
    expect(costs.slice).not.toBeNull();
    expect(costs.slice?.key).not.toBe(daily.slice?.key);
    // Both keyed slices are members of the one page batch value (one `usage.query`), not two reads.
    expect(new Set(batches.at(-1))).toEqual(new Set([daily.slice!.key, costs.slice!.key]));
  });
});
