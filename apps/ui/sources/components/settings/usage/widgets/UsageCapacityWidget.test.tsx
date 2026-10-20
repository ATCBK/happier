import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { t } from '@/text';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { ConnectedServiceQuotaGetResultV1Schema } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { WidgetPresentationProvider } from '@happier-dev/plugin-ui';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { QualifiedConnectedAccountGroupV4Schema } from '@happier-dev/protocol/connect/qualifiedConnectedAccountsV4';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { storage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, publishAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';

let previousSnapshot = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
let previousProfile = storage.getState().profile;
let previousScope = storage.getState().profileScope;
beforeEach(() => {
  previousSnapshot = getAppliedActiveServerSnapshot();
  previousAvailable = isAppliedActiveServerRuntimeAvailable();
  previousProfile = storage.getState().profile;
  previousScope = storage.getState().profileScope;
  publishAppliedActiveServerSnapshot({ serverId: 'home', serverUrl: 'https://capacity.test', generation: 0 }, true);
  storage.setState({ profileScope: { serverId: 'home', accountId: 'capacity-account' },
    profile: AccountProfileSchema.parse({ id: 'capacity-account', connectedAccountGroupsV4: ['first', 'second', 'duo', 'one'].map(groupId =>
      QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service: { pluginId: 'happier.agent.claude', localId: 'claude-subscription' }, groupId },
        displayName: groupId, incarnation: `${groupId}:1`, policy: { strategy: 'priority' }, generation: 1, runtimeStateRevision: 1,
        state: {}, members: [], activeConnectedAccountId: null, createdAt: 1, updatedAt: 1 })) }) });
});
afterEach(() => {
  standardCleanup();
  storage.setState({ profile: previousProfile, profileScope: previousScope });
  publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
});

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

it('renders every overlapping pool membership without duplicating standalone Account facts', async () => {
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const query = normalizeUsageQuery({});
  const quota = ['work', 'personal', 'standalone'].map(accountId => {
    const recordKey = { providerId: 'anthropic', accountSubjectId: accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    return ConnectedServiceQuotaGetResultV1Schema.parse({
      source: { ref: { service, accountId }, bindingKind: 'account' },
      current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'anthropic', accountSubject: { kind: 'providerSubject', id: accountId },
        observedAtMs: Date.now(), fetchedAtMs: Date.now(), staleAfterMs: 60_000,
        source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [], planLabel: null },
      pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
    });
  });
  const slice = resolveUsagePageAggregation({ queries: [query], quota: { status: 'available', value: quota },
    pools: [{ query, value: [
      { group: { service, groupId: 'first' }, memberAccountIds: ['work', 'personal'], activeAccountId: 'work', selection: { status: 'pending' } },
      { group: { service, groupId: 'second' }, memberAccountIds: ['work', 'personal'], activeAccountId: null, selection: { status: 'pending' } },
    ] }],
  }).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageCapacityWidget } = await import('./UsageCapacityWidget');
  const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
    <UsageCapacityWidget id="usage_capacity" model={model} slice={slice} query={query} serverId="home" testID="capacity" />
  </InjectedAuthProvider>);
  expect(screen.findAllHostsByTestId('capacity.cell.work')).toHaveLength(2);
  expect(screen.findAllHostsByTestId('capacity.cell.personal')).toHaveLength(2);
  expect(screen.findAllHostsByTestId('capacity.cell.standalone')).toHaveLength(1);
  const renderSlice = (next: typeof slice) => <InjectedAuthProvider credentials={null}>
    <UsageCapacityWidget id="usage_capacity" model={{ ...model, slice: next }} slice={next} query={query} serverId="home" testID="capacity" />
  </InjectedAuthProvider>;
  await screen.update(renderSlice({ ...slice, pools: slice.pools!.map(pool => ({ ...pool,
    selection: { status: 'error', machineId: 'machine', errorCode: 'MACHINE_RPC_TIMEOUT' },
  })) }));
  expect(screen.findHostByTestId('capacity.usedFirst.cause')).not.toBeNull();
  expect(screen.getTextContent()).toContain(t('usage.board.plans.usedFirstReadFailed'));
  const recovered = { ...slice, pools: slice.pools!.map(pool => {
    const candidates = pool.memberAccountIds.map(profileId => ({ profileId, priority: 1, createdAtMs: 1, enabled: true, leastLimitedScore: null }));
    return { ...pool, selection: { status: 'available' as const, machineId: 'machine', asOfMs: 200,
      value: ConnectedServicePoolSelectionGetResponseV1Schema.parse({ group: pool.group, observedAtMs: 200,
        selection: { selected: candidates[0], reason: 'selected', excluded: [], decisionTrace: {
          activeProfileId: candidates[0]!.profileId, reason: 'selected', strategy: 'priority', selectionBasis: 'active_stickiness',
          sticky: true, orderedEligibleCandidates: candidates, candidates: [],
        } } }),
    } };
  }) };
  await screen.update(renderSlice(recovered));
  expect(screen.findHostByTestId('capacity.usedFirst.cause')).toBeNull();
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.usedFirstReadFailed'));
  expect(screen.findAllHostsByTestId('capacity.cell.work')).toHaveLength(2);
});

it('outlines only a pool of two or more members; a pool of one reads as its account does', async () => {
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const query = normalizeUsageQuery({});
  const quota = ['work', 'personal', 'solo'].map(accountId => {
    const recordKey = { providerId: 'anthropic', accountSubjectId: accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    return ConnectedServiceQuotaGetResultV1Schema.parse({
      source: { ref: { service, accountId }, bindingKind: 'account' },
      current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'anthropic', accountSubject: { kind: 'providerSubject', id: accountId },
        observedAtMs: Date.now(), fetchedAtMs: Date.now(), staleAfterMs: 60_000,
        source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [], planLabel: null },
      pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
    });
  });
  const slice = resolveUsagePageAggregation({ queries: [query], quota: { status: 'available', value: quota },
    pools: [{ query, value: [
      { group: { service, groupId: 'duo' }, memberAccountIds: ['work', 'personal'], activeAccountId: 'work', selection: { status: 'pending' } },
      { group: { service, groupId: 'one' }, memberAccountIds: ['solo'], activeAccountId: 'solo', selection: { status: 'pending' } },
    ] }],
  }).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageCapacityWidget } = await import('./UsageCapacityWidget');
  const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
    <UsageCapacityWidget id="usage_capacity" model={model} slice={slice} query={query} serverId="home" testID="capacity" />
  </InjectedAuthProvider>);
  expect(screen.findHostByTestId('capacity.pool.duo')).not.toBeNull();
  expect(screen.findHostByTestId('capacity.pool.one')).toBeNull();
  expect(screen.findHostByTestId('capacity.cell.solo')).not.toBeNull();
});

it('keeps each reset and renewal as an exact point when the shared plot cannot fit', async () => {
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const query = normalizeUsageQuery({});
  const now = Date.now();
  const recordKey = { providerId: 'anthropic', accountSubjectId: 'work', subjectKind: 'account', quotaScope: 'account' } as const;
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({
    source: { ref: { service, accountId: 'work' }, bindingKind: 'account' },
    current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'anthropic', accountSubject: { kind: 'providerSubject', id: 'work' },
      observedAtMs: now, fetchedAtMs: now, staleAfterMs: 60_000,
      source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', planLabel: 'Max',
      subscription: { status: 'subscribed', observedAtMs: now, staleAfterMs: 60_000, renewal: 'on', currentPeriodEndAtMs: now + 86_400_000 },
      meters: ['Weekly', 'Monthly'].map((label, index) => ({ meterId: label, label, used: null, limit: null,
        usedPct: 40, utilizationPct: 40, unit: 'count', status: 'ok', resetAtMs: now + (index + 1) * 3_600_000,
        resetsAt: now + (index + 1) * 3_600_000 })) },
    pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
  });
  const slice = resolveUsagePageAggregation({ queries: [query], quota: { status: 'available', value: [read] } }).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageResetPlannerWidget } = await import('./UsageResetPlannerWidget');
  const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
    <WidgetPresentationProvider value={{ size: 'small', footprint: { columns: 2, columnSpan: 1, rowSpan: 1, width: 'half', height: 'compact' }, geometry: { width: 320, height: 96 } }}>
      <UsageResetPlannerWidget id="usage_resets" model={model} slice={slice} query={query} serverId="home" testID="reset" />
    </WidgetPresentationProvider>
  </InjectedAuthProvider>);
  expect(screen.findByTestId('reset.timeline-plot')).toBeNull();
  const rows = [0, 1, 2].map(index => screen.findHostByTestId(`reset.timeline-values-row-${index}`));
  expect(rows.every(Boolean)).toBe(true);
  expect(rows.every(row => !row!.props.accessibilityLabel.includes('End:'))).toBe(true);
  expect(screen.getTextContent()).toContain('Weekly');
  expect(screen.getTextContent()).toContain('Monthly');
});

it('names only pending accounts once in the held headline row, and drops it once nothing is pending', async () => {
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const query = normalizeUsageQuery({});
  const recordKey = { providerId: 'anthropic', accountSubjectId: 'work', subjectKind: 'account', quotaScope: 'account' } as const;
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({
    source: { ref: { service, accountId: 'work' }, bindingKind: 'account' },
    current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'anthropic', accountSubject: { kind: 'providerSubject', id: 'work' },
      observedAtMs: Date.now(), fetchedAtMs: Date.now(), staleAfterMs: 60_000,
      source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', meters: [], planLabel: null },
    pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
  });
  const settled = resolveUsagePageAggregation({ queries: [query], quota: { status: 'available', value: [read] } }).results[0]!;
  const pending = ['personal', 'shared'].map(accountId => ({ source: `quota:${createCanonicalJsonSigningInput({
    bindingKind: 'account', ref: { service, accountId },
  })}`, status: 'pending' as const }));
  const reading = { ...settled, sources: [...settled.sources, ...pending] };
  const { UsageCapacityWidget } = await import('./UsageCapacityWidget');
  const render = (slice: typeof settled) => renderScreen(<InjectedAuthProvider credentials={null}>
    <UsageCapacityWidget id="usage_capacity" slice={slice} query={query} serverId="home" testID="capacity"
      model={{ requestedQuery: null, shownQuery: null, slice, pending: false, error: null, freshness: 'fresh',
        updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel} />
  </InjectedAuthProvider>);
  const screen = await render(reading);
  expect(screen.findByTestId('capacity.reading')).not.toBeNull();
  expect.soft(screen.getTextContent()).toContain(t('usage.board.plans.capacityReading', { count: 2 }));
  // The headline owns first-load progress; a second polite footer must stay quiet.
  expect.soft(screen.findAllByType(SurfaceFreshnessLine)).toHaveLength(0);
  expect((await render(settled)).findByTestId('capacity.reading')).toBeNull();
});

it.each([['loaded_data', true], ['not_loaded', false]] as const)('says only an account that reported no allowance has none to show (%s), never an unread placeholder (R5A-03)', async (state, observed) => {
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const query = normalizeUsageQuery({});
  const recordKey = { providerId: 'anthropic', accountSubjectId: 'mail', subjectKind: 'account', quotaScope: 'account' } as const;
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({
    source: { ref: { service, accountId: 'mail' }, bindingKind: 'account' },
    current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
      providerId: 'anthropic', accountSubject: { kind: 'providerSubject', id: 'mail' },
      observedAtMs: observed ? Date.now() : 0, fetchedAtMs: observed ? Date.now() : 0, staleAfterMs: 60_000,
      source: 'providerHttp', confidence: 'confirmed', state, meters: [], planLabel: null },
    pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
  });
  const slice = resolveUsagePageAggregation({ queries: [query], quota: { status: 'available', value: [read] } }).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageCapacityWidget } = await import('./UsageCapacityWidget');
  const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
    <UsageCapacityWidget id="usage_capacity" model={model} slice={slice} query={query} serverId="home" testID="capacity" />
  </InjectedAuthProvider>);
  // An observed empty result keeps its segment and says so; a never-read placeholder is no segment at all,
  // only the one collapsed "not read yet" line (R1), never an epoch date or a silent dash.
  if (observed) {
    expect(screen.findHostByTestId('capacity.cell.mail')).not.toBeNull();
    expect(screen.getTextContent()).toContain(t('usage.board.plans.cellNoAllowance'));
    expect(screen.findHostByTestId('capacity.unread')).toBeNull();
  } else {
    expect(screen.findHostByTestId('capacity.cell.mail')).toBeNull();
    expect(screen.getTextContent()).not.toContain(t('usage.board.plans.cellNoAllowance'));
    expect(screen.findByTestId('capacity.unread')).not.toBeNull();
    expect(screen.getTextContent()).toContain(t('usage.board.plans.capacityNotRead', { count: 1 }));
  }
});

it.each([['medium', true, 520, false], ['tall', true, 520, false], ['full', false, 520, false], ['medium', true, 180, true]] as const)('draws one pooled bar with labels under its segments beside other widgets (%s), the per-account grid at full width, and one row per account under a bar too narrow for labels', async (size, pooled, width, listed) => {
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const query = normalizeUsageQuery({});
  const quota = [['work', 'loaded_data', 40], ['personal', 'loaded_data', 75], ['spare', 'not_loaded', null]].map(([accountId, state, usedPct]) => {
    const recordKey = { providerId: 'anthropic', accountSubjectId: accountId as string, subjectKind: 'account', quotaScope: 'account' } as const;
    const observed = state === 'loaded_data';
    return ConnectedServiceQuotaGetResultV1Schema.parse({
      source: { ref: { service, accountId }, bindingKind: 'account' },
      current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'anthropic', accountSubject: { kind: 'providerSubject', id: accountId },
        observedAtMs: observed ? Date.now() : 0, fetchedAtMs: observed ? Date.now() : 0, staleAfterMs: 60_000,
        source: 'providerHttp', confidence: 'confirmed', state, planLabel: null,
        meters: usedPct === null ? [] : [{ meterId: 'weekly', label: 'Weekly', usedPct, utilizationPct: usedPct, used: null, limit: null,
          unit: 'count', status: 'ok', resetsAt: Date.now() + 86_400_000, resetAtMs: Date.now() + 86_400_000, windowDurationMs: 7 * 86_400_000 }] },
      pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
    });
  });
  const slice = resolveUsagePageAggregation({ queries: [query], quota: { status: 'available', value: quota } }).results[0]!;
  const model = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
  const { UsageCapacityWidget } = await import('./UsageCapacityWidget');
  const screen = await renderScreen(<InjectedAuthProvider credentials={null}>
    <WidgetPresentationProvider value={{ size, footprint: { columns: 2, columnSpan: 1, rowSpan: 1, width: 'half', height: 'regular' },
      geometry: { width, height: 320 } }}>
      <UsageCapacityWidget id="usage_capacity" model={model} slice={slice} query={query} serverId="home" testID="capacity" />
    </WidgetPresentationProvider>
  </InjectedAuthProvider>);
  // Read accounts are segments; the never-read one is one quiet line, and the headline counts only reads.
  expect(screen.findHostByTestId('capacity.cell.work')).not.toBeNull();
  expect(screen.findHostByTestId('capacity.cell.personal')).not.toBeNull();
  expect(screen.findHostByTestId('capacity.cell.spare')).toBeNull();
  expect(screen.getTextContent()).toContain(t('usage.board.plans.capacityNotRead', { count: 1 }));
  expect(screen.getTextContent()).toContain(t('usage.board.plans.capacityAccounts', { count: 2 }));
  expect(screen.findHostByTestId('capacity.pooled') !== null).toBe(pooled);
  // A bar too narrow for a label under each segment stays one bar; its accounts are listed beneath it instead.
  expect(screen.findHostByTestId('capacity.accounts') !== null).toBe(listed);
});

it.each(['pending', 'not_loaded'] as const)('shows an observed headline with first-read progress (%s) and replaces it when a tighter account answers', async status => {
  const service = { pluginId: 'happier.agent.claude', localId: 'claude-subscription' };
  const query = normalizeUsageQuery({});
  const reads = ['roomy', 'tight'].map((accountId, index) => {
    const recordKey = { providerId: 'anthropic', accountSubjectId: accountId, subjectKind: 'account', quotaScope: 'account' } as const;
    return ConnectedServiceQuotaGetResultV1Schema.parse({
      source: { ref: { service, accountId }, bindingKind: 'account' },
      current: { v: 1, recordId: buildProviderAccountUsageRecordId(recordKey), recordKey,
        providerId: 'anthropic', accountSubject: { kind: 'providerSubject', id: accountId },
        observedAtMs: Date.now(), fetchedAtMs: Date.now(), staleAfterMs: 60_000,
        source: 'providerHttp', confidence: 'confirmed', state: 'loaded_data', planLabel: null,
        meters: [{ meterId: 'week', label: 'Weekly', used: null, limit: null, usedPct: index ? 93 : 40,
          utilizationPct: index ? 93 : 40, unit: 'count', status: 'ok', resetsAt: null }] },
      pace: [], targets: [], waitingWork: { status: 'unavailable', reason: 'unsupported' },
    });
  });
  const settled = resolveUsagePageAggregation({ queries: [query], quota: { status: 'available', value: reads } }).results[0]!;
  const partial = { ...settled, quota: reads.slice(0, 1), sources: [...settled.sources, {
    source: `quota:${createCanonicalJsonSigningInput(reads[1]!.source)}`, status,
  }] };
  const { UsageCapacityWidget } = await import('./UsageCapacityWidget');
  const body = (slice: typeof settled) => <InjectedAuthProvider credentials={null}>
    <UsageCapacityWidget id="usage_capacity" slice={slice} query={query} serverId="home" testID="capacity"
      model={{ requestedQuery: null, shownQuery: null, slice, pending: false, error: null, freshness: 'fresh',
        updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel} />
  </InjectedAuthProvider>;
  const screen = await renderScreen(body(partial));
  expect(screen.findHostByTestId('capacity.tightest')).not.toBeNull();
  expect(screen.getTextContent()).toContain('60%');
  if (status === 'pending') {
    expect(screen.findByTestId('capacity.reading')).not.toBeNull();
    expect(screen.getTextContent()).toContain(t('usage.board.plans.capacityReading', { count: 1 }));
    expect(screen.findAllByType(SurfaceFreshnessLine)).toHaveLength(0);
  } else {
    // An unissued read is incomplete coverage, not an active "Reading 0 accounts".
    expect(screen.findByTestId('capacity.reading')).toBeNull();
    expect(screen.getTextContent()).not.toContain(t('usage.board.plans.capacityReading', { count: 0 }));
    expect(screen.getTextContent()).not.toContain(t('usage.board.plans.capacityAccounts', { count: 2 }));
    expect(screen.findAllByType(SurfaceFreshnessLine)).toHaveLength(1);
  }
  await screen.update(body(settled));
  expect(screen.findHostByTestId('capacity.tightest')).not.toBeNull();
  expect(screen.getTextContent()).toContain('7%');
  expect(screen.findByTestId('capacity.reading')).toBeNull();
});
