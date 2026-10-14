import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { renderScreen as renderScreenAtHost, standardCleanup } from '@/dev/testkit';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { OverlayPortalProvider, OverlayPortalHost } from '@/components/ui/popover/OverlayPortal';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { ConnectedServicePoolSelectionGetRequestV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { getPreferredLanguage, preloadTranslationsForSettings, setPreferredLanguageFromSettings, t } from '@/text';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import {
  ConnectedServiceQuotaGetResultV1Schema,
  type ConnectedServiceQuotaGetResultV1,
} from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { buildProviderAccountUsageRecordId } from '@happier-dev/protocol/connect/account-usage-primitives';
import { BurnUpChart } from '@happier-dev/plugin-ui/presentation';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { storage } from '@/sync/domains/state/storageStore';
import {
  getAppliedActiveServerSnapshot,
  isAppliedActiveServerRuntimeAvailable,
  publishAppliedActiveServerSnapshot,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import type { UsageWidgetBodyModel } from '../../useUsageWidgetResource';

// Machine RPC is the genuine transport boundary. The two reset-start cases below still substitute
// the internal Action front door: their witness/privacy UI assertions do not prove admission/custody.
const execute = vi.hoisted(() => vi.fn());
const selectionTransport = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
  const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
  return createServerScopedMachineRpcBoundaryMock(selectionTransport);
});
vi.mock(
  '@/sync/ops/actions/frontDoorRuntimeActionExecutor',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')
    >()),
    createFrontDoorActionExecute: () => execute,
  }),
);
vi.mock('react-native', async () =>
  (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }, {
    Platform: { isPad: true },
    useWindowDimensions: () => ({ width: 1000, height: 800, scale: 1, fontScale: 1 }),
  }),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const service = {
  pluginId: 'happier.agent.claude',
  localId: 'claude-subscription',
};
const query = normalizeUsageQuery({});

let previousSnapshot = getAppliedActiveServerSnapshot();
let comparisonHome: Awaited<ReturnType<typeof serveAccountHomes>> | undefined;
let previousAvailable = isAppliedActiveServerRuntimeAvailable();
let restoreFrameBoundary: (() => void) | undefined;
beforeEach(() => {
  restoreFrameBoundary = withPopoverWebGlobals();
  previousSnapshot = getAppliedActiveServerSnapshot();
  previousAvailable = isAppliedActiveServerRuntimeAvailable();
});
afterEach(async () => {
  standardCleanup();
  restoreFrameBoundary?.();
  execute.mockReset();
  selectionTransport.mockReset();
  await comparisonHome?.dispose(); comparisonHome = undefined;
  (
    await import('@/sync/domains/scope/activeServerAccountScope')
  ).retireActiveServerAccountScopeLifetime();
  publishAppliedActiveServerSnapshot(previousSnapshot, previousAvailable);
});

type Meter = Readonly<{
  meterId: string;
  label: string;
  usedPct: number;
  resetAtMs: number;
  windowDurationMs: number;
}>;

function quotaRead(
  accountId: string,
  now: number,
  meters: readonly Meter[],
  extra: Record<string, unknown> = {},
  current: Record<string, unknown> = {},
): ConnectedServiceQuotaGetResultV1 {
  const recordKey = {
    providerId: 'anthropic',
    accountSubjectId: accountId,
    subjectKind: 'account',
    quotaScope: 'account',
  } as const;
  const recordId = buildProviderAccountUsageRecordId(recordKey);
  return ConnectedServiceQuotaGetResultV1Schema.parse({
    source: { ref: { service, accountId }, bindingKind: 'account' },
    current: {
      v: 1,
      recordId,
      recordKey,
      providerId: 'anthropic',
      accountSubject: { kind: 'providerSubject', id: accountId },
      observedAtMs: now,
      fetchedAtMs: now,
      staleAfterMs: HOUR,
      source: 'providerHttp',
      confidence: 'confirmed',
      state: 'loaded_data',
      planLabel: `Plan ${accountId}`,
      meters: meters.map((meter) => ({
        ...meter,
        used: null,
        limit: null,
        utilizationPct: meter.usedPct,
        unit: 'count',
        status: 'ok',
        resetsAt: meter.resetAtMs,
      })),
      ...current,
    },
    pace: meters.map((meter) => ({
      meterId: meter.meterId,
      value: {
        status: 'available',
        window: {
          recordId,
          meterId: meter.meterId,
          resetAtMs: meter.resetAtMs,
          windowStartAtMs: meter.resetAtMs - meter.windowDurationMs,
          windowDurationMs: meter.windowDurationMs,
        },
        usedFraction: meter.usedPct / 100,
        elapsedFraction: 0.5,
        evenPaceFraction: 0.5,
        pace: meter.usedPct / 50,
        projectedResetUtilizationFraction: meter.usedPct / 50,
        qualification: 'confirmed',
        sampleCount: 7,
        empiricalRange: { min: 0.6, max: 0.9 },
        observedCurve: [
          { observedAtMs: now - HOUR, usedFraction: meter.usedPct / 200 },
          { observedAtMs: now, usedFraction: meter.usedPct / 100 },
        ],
      },
    })),
    targets: [],
    waitingWork: { status: 'unavailable', reason: 'unsupported' },
    ...extra,
  });
}

function bodyProps(
  quota: readonly ConnectedServiceQuotaGetResultV1[],
  pools?: Parameters<typeof resolveUsagePageAggregation>[0]['pools'],
  shownQuery = query,
) {
  const slice = resolveUsagePageAggregation({
    queries: [shownQuery],
    nowMs: Date.now(),
    quota: { status: 'available', value: [...quota] },
    ...(pools ? { pools } : {}),
  }).results[0]!;
  const model = {
    requestedQuery: null,
    shownQuery: null,
    slice,
    pending: false,
    error: null,
    freshness: 'fresh',
    updatingPreviousPeriod: false,
    refreshing: false,
    refresh: async () => {},
  } satisfies UsageWidgetBodyModel;
  return { model, slice, query: shownQuery, serverId: 'home' };
}

const wrap = (node: React.ReactElement) => (
  <InjectedAuthProvider credentials={null}>
    <OverlayPortalProvider>{node}<OverlayPortalHost /></OverlayPortalProvider>
  </InjectedAuthProvider>
);

// Native measurement is the physical boundary; Popover open/close, placement and portal owners run.
const renderScreen = (node: Parameters<typeof renderScreenAtHost>[0]) => renderScreenAtHost(node, {
  createNodeMock: () => ({
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(200, 200, 120, 32),
  }),
});

it('shows the canonical capacity weather and insufficient model/reset basis inside the existing plan fit body', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 80,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const other = quotaRead('other', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 20,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...bodyProps([read, other])} id="usage_plan_fit" testID="fit" />));
  // A plan is one row; its basis lines open under Details.
  expect(screen.findByTestId('fit.plan.work.weather.weekly')).toBeFalsy();
  await screen.pressByTestIdAsync('fit.plan.work.details-header');
  expect(screen.findByTestId('fit.plan.work.weather.weekly')).toBeTruthy();
  // What no account has a basis for yet is one line for the whole widget, never one per account.
  expect(screen.findByTestId('fit.plan.work.insufficient')).toBeFalsy();
  expect(screen.findByTestId('fit.plan.other.insufficient')).toBeFalsy();
  // It is one quiet promise, not a list of internal feature names.
  const summary = String(screen.findByTestId('fit.notRecorded')!.props.children);
  expect(summary).toBe(t('usage.board.plans.moreDetailLater'));
  expect(screen.getTextContent()).not.toContain(t('usage.board.plans.modelHeadroomTitle'));
  expect(screen.findByTestId('fit.plan.work.modelHeadroom.weekly.insufficient')).toBeFalsy();
  expect(screen.findByTestId('fit.plan.work.pricePerReset.weekly.insufficient')).toBeFalsy();
  expect(screen.findAllByType((await import('@/components/settings/connectedServices/ConnectedServiceMark')).ConnectedServiceMark)
    .find(node => node.props.legacyServiceId === 'claude-subscription')).toBeTruthy();
});

it('names available model-meter headroom through the catalog and readable unknown fallback', async () => {
  const now = Date.now();
  const base = quotaRead('work', now, [{ meterId: 'known', label: 'Known model', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }, { meterId: 'external', label: 'External model', usedPct: 40,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }]);
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({ ...base, current: { ...base.current,
    meters: base.current!.meters.map(meter => ({ ...meter,
      modelId: meter.meterId === 'known' ? 'claude-fable-5' : 'third-party/model-snapshot' })) } });
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...bodyProps([read])} id="usage_plan_fit" testID="fit" />));
  await screen.pressByTestIdAsync('fit.plan.work.details-header');
  expect(screen.findByTestId('fit.plan.work.modelHeadroom.known')).toBeTruthy();
  expect(screen.findByTestId('fit.plan.work.modelHeadroom.external')).toBeTruthy();
  expect(screen.getTextContent()).toContain('Fable 5');
  expect(screen.getTextContent()).toContain('Third Party Model Snapshot');
  expect(screen.getTextContent()).not.toContain('claude-fable-5');
  expect(screen.getTextContent()).not.toContain('third-party/model-snapshot');
});

it('keeps unreported windows reachable behind one count and shows each reset once', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }, { meterId: 'daily', label: 'Daily', usedPct: 10,
    resetAtMs: now + HOUR, windowDurationMs: DAY }]);
  const unknown = { ...read.current!.meters[0]!, meterId: 'unknown', label: 'Unknown allowance',
    usedPct: null, utilizationPct: null };
  const partial = ConnectedServiceQuotaGetResultV1Schema.parse({ ...read,
    current: { ...read.current, meters: [...read.current!.meters, unknown] } });
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
  const screen = await renderScreen(wrap(<>
    <UsageCapacityWidget {...bodyProps([partial])} id="usage_capacity" testID="cap" />
    <UsageProjectionsWidget {...bodyProps([partial])} id="usage_projections" testID="proj" />
    <UsageResetPlannerWidget {...bodyProps([partial], undefined, normalizeUsageQuery({ session: [] }))} id="usage_resets" testID="reset" />
  </>));
  // A capacity segment is one figure and one plan label (lab ucap/wgusage-CD): its other windows are
  // in its accessible name and in Projections' disclosures, never stacked inline in the bar.
  expect(screen.findByTestId('cap.cell.work.unreported-header')).toBeFalsy();
  expect(screen.findByTestId('cap.cell.work.reported-header')).toBeFalsy();
  expect(String(screen.findByTestId('cap.cell.work')!.props.accessibilityLabel)).toContain('Daily');
  expect(screen.findByTestId('proj.window.work.weekly')).toBeFalsy();
  await screen.pressByTestIdAsync('proj.reported-header');
  expect(screen.findByTestId('proj.window.work.weekly')).toBeTruthy();
  expect(screen.findAllByType((await import('@/components/settings/connectedServices/ConnectedServiceMark')).ConnectedServiceMark)
    .every(node => node.props.legacyServiceId === 'claude-subscription')).toBe(true);
  expect(screen.findByTestId('proj.window.work.unknown')).toBeFalsy();
  await screen.pressByTestIdAsync('proj.unreported-header');
  expect(screen.findByTestId('proj.window.work.unknown')).toBeTruthy();
  expect(screen.findByTestId('reset.list')).toBeTruthy();
  expect(screen.findByTestId('reset.timeline')).toBeFalsy();
});

it('lists every reported window with its projection beside other widgets, without the burn-up or disclosures', async () => {
  const now = Date.now();
  const read = quotaRead('work', now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 30,
    resetAtMs: now + DAY, windowDurationMs: 7 * DAY }, { meterId: 'daily', label: 'Daily', usedPct: 10,
    resetAtMs: now + HOUR, windowDurationMs: DAY }]);
  const unknown = { ...read.current!.meters[0]!, meterId: 'unknown', label: 'Unknown allowance',
    usedPct: null, utilizationPct: null };
  const partial = ConnectedServiceQuotaGetResultV1Schema.parse({ ...read,
    current: { ...read.current, meters: [...read.current!.meters, unknown] } });
  const { WidgetPresentationProvider } = await import('@happier-dev/plugin-ui');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([partial])} id="usage_projections" testID="proj" />
  </WidgetPresentationProvider>));
  // Lab wgusage-CD "Limits": the meters are the body, read at a glance.
  expect(screen.findByTestId('proj.window.work.weekly')).toBeTruthy();
  expect(screen.findByTestId('proj.window.work.daily')).toBeTruthy();
  expect(screen.findAllByType(BurnUpChart)).toHaveLength(0);
  expect(screen.findByTestId('proj.reported-header')).toBeFalsy();
  expect(screen.findByTestId('proj.pastCycles-header')).toBeFalsy();
  // Neither window has a pace for the same reason: it is said once under the list, not on each row.
  // Each window has its own projection, so no shared reason is said.
  expect(screen.findByTestId('proj.sharedReason')).toBeFalsy();
  // The unreported window is one quiet count; its row lives on the Plans view.
  expect(screen.findByTestId('proj.unreported')).toBeTruthy();
  expect(screen.findByTestId('proj.window.work.unknown')).toBeFalsy();
  // No window has a pace for the same reason: it is said once under the list, not on each row.
  const unpaced = ConnectedServiceQuotaGetResultV1Schema.parse({ ...partial, pace: [] });
  const quiet = await renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
    footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
    <UsageProjectionsWidget {...bodyProps([unpaced])} id="usage_projections" testID="quiet" />
  </WidgetPresentationProvider>));
  expect(quiet.findByTestId('quiet.sharedReason')).toBeTruthy();
  // No window has a pace: the pace legend explains nothing here, in the list or on the Plans view.
  expect(quiet.findByTestId('quiet.legend')).toBeFalsy();
  const own = await renderScreen(wrap(<UsageProjectionsWidget {...bodyProps([unpaced])} id="usage_projections" testID="own" />));
  expect(own.findByTestId('own.noPace')).toBeTruthy();
  expect(own.findByTestId('own.reported')).toBeTruthy();
  expect(own.findByTestId('own.legend')).toBeFalsy();
  expect(quiet.getTextContent().split(t('usage.board.plans.paceNotDerived')).length - 1).toBe(1);
});

it('holds the list room its accounts will fill while their first allowance reads are pending, then lets it go', async () => {
  const { QualifiedConnectedServiceUsageSourceV4Schema } = await import('@happier-dev/protocol/connect/qualifiedConnectedAccountsV4');
  const { WidgetPresentationProvider } = await import('@happier-dev/plugin-ui');
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const sourcesFor = (count: number, status: 'pending' | 'available') => Array.from({ length: count }, (_, index) => ({
    source: `quota:${JSON.stringify(QualifiedConnectedServiceUsageSourceV4Schema.parse({ bindingKind: 'account',
      ref: { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: `acct-${index}` } }))}`,
    status,
  }));
  const render = async (count: number, status: 'pending' | 'available') => {
    const slice = resolveUsagePageAggregation({ queries: [query], nowMs: Date.now(), sources: sourcesFor(count, status),
      ...(status === 'available' ? { quota: { status: 'available' as const, value: [] } } : {}) }).results[0]!;
    const model = { requestedQuery: null, shownQuery: null, slice, pending: status === 'pending', error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} } satisfies UsageWidgetBodyModel;
    return renderScreen(wrap(<WidgetPresentationProvider value={{ size: 'medium',
      footprint: { columns: 2, columnSpan: 1, rowSpan: 2, width: 'half', height: 'regular' }, geometry: { width: 520, height: 260 } }}>
      <UsageProjectionsWidget model={model} slice={slice} query={query} serverId="home" id="usage_projections" testID="proj" />
    </WidgetPresentationProvider>));
  };
  const heldRoom = (screen: Awaited<ReturnType<typeof render>>) => {
    const style = ([] as unknown[]).concat(screen.findByTestId('proj.projections')?.props.style ?? []).flat(2);
    return style.reduce<number>((held, entry) => (entry && typeof entry === 'object' && 'minHeight' in entry ? Number(entry.minHeight) : held), 0);
  };
  // Each allowance account is expected to report a session and a longer window, up to the rows a list leads with:
  // reads fill that room as they arrive, and a settled list holds none.
  const five = heldRoom(await render(5, 'pending'));
  const one = heldRoom(await render(1, 'pending'));
  expect(one).toBeGreaterThan(0);
  expect(five).toBeGreaterThan(one);
  expect(heldRoom(await render(3, 'available'))).toBe(0);
});

it('shows attributed API-equivalent account value and a qualified price multiple without claiming paid savings', async () => {
  const now = Date.now();
  const shownQuery = normalizeUsageQuery({ period: { startMs: now - DAY, endMs: now + DAY } });
  const read = quotaRead('work', now, [], {}, { subscription: {
    status: 'subscribed', renewal: 'on', observedAtMs: now, staleAfterMs: HOUR,
    currentPeriodStartAtMs: now - DAY, currentPeriodEndAtMs: now + DAY,
    enteredMonthlyPrice: { amount: 2, currency: 'USD', enteredAtMs: now - DAY },
  } });
  const base = bodyProps([read], undefined, shownQuery);
  const tokens = { input: 1_000_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 1_000_000 };
  const slice = resolveUsagePageAggregation({ queries: [shownQuery], nowMs: now,
    quota: { status: 'available', value: [read] }, pricingOverrides: { model: { kind: 'rates', inputUsdPerMillion: 4, outputUsdPerMillion: 1 } },
    accounting: [{ query: shownQuery, status: 'available', value: { v: 1,
      totals: { eventCount: 1, tokens, cost: { reportedUsd: 20, estimatedUsd: 8, currency: 'USD' } },
      contributions: [{ id: 'account-value', eventCount: 1, observedAtMs: now - 1, sessionId: 's', turnId: 't', agentId: 'agent',
        modelId: 'model', machineId: null, projectKey: null, workspaceId: null, source: 'runtime', tokens,
        cost: { reportedUsd: 20, estimatedUsd: 8, currency: 'USD' }, providerAttribution: 'known', connectedAccount: read.source.ref }],
    } }],
  }).results[0]!;
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...base} slice={slice} model={{ ...base.model, slice }} id="usage_plan_fit" testID="fit" />));
  await screen.pressByTestIdAsync('fit.plan.work.details-header');
  const value = screen.findHostByTestId('fit.plan.work.value');
  expect(value).toBeTruthy();
  expect(value!.props.accessibilityLabel).toContain('$4.00');
  expect(value!.props.accessibilityLabel).toContain('2');
  expect(value!.props.accessibilityLabel).toContain('API-equivalent');
  expect(value!.props.accessibilityLabel).not.toContain('$20.00');
  expect(value!.props.accessibilityLabel).not.toContain('saved');
});

it('shows a recorded week from accounting even without connected plan accounts', async () => {
  const startMs = Date.UTC(2026, 8, 28);
  const endMs = Date.UTC(2026, 9, 5);
  const shownQuery = normalizeUsageQuery({ period: { startMs, endMs } });
  const base = bodyProps([], undefined, shownQuery);
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const slice = resolveUsagePageAggregation({ queries: [shownQuery], nowMs: endMs,
    accounting: [{ query: shownQuery, status: 'available', value: { v: 1,
      totals: { eventCount: 1, tokens, cost: { reportedUsd: 0, estimatedUsd: 0, currency: 'USD' } },
      activity: { calendarDays: [{ date: '2026-10-01', eventCount: 1 }], weekdayHourBuckets: [] },
    } }] }).results[0]!;
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const screen = await renderScreen(wrap(<UsagePlanFitWidget {...base} slice={slice} model={{ ...base.model, slice }} id="usage_plan_fit" testID="fit" />));
  expect(screen.findByTestId('fit.recordedWeek')).toBeTruthy();
});

it("lists a pool in the selector's own order and builds the why detail from its trace only when opened", async () => {
  const now = Date.now();
  const weekly = (usedPct: number): Meter => ({
    meterId: 'weekly',
    label: 'Weekly',
    usedPct,
    resetAtMs: now + 2 * DAY,
    windowDurationMs: 7 * DAY,
  });
  const quota = [
    quotaRead('work', now, [weekly(30)]),
    quotaRead('personal', now, [weekly(10)]),
    quotaRead('side', now, [weekly(100)]),
  ];
  const group = { service, groupId: 'pool' };
  const candidate = (profileId: string, priority: number) => ({
    profileId,
    priority,
    createdAtMs: 1,
    enabled: true,
    leastLimitedScore: 62,
    preferenceDeadlineMs: now + 2 * DAY,
  });
  const selection = {
    selected: candidate('personal', 1),
    reason: 'selected' as const,
    excluded: [
      {
        profileId: 'side',
        reason: 'quota_exhausted' as const,
        retryAtMs: now + 3 * HOUR,
      },
    ],
    decisionTrace: {
      activeProfileId: 'personal',
      reason: 'selected' as const,
      strategy: 'expiry_first' as const,
      selectionBasis: 'active_stickiness' as const,
      sticky: true,
      orderedEligibleCandidates: [
        candidate('personal', 1),
        candidate('work', 0),
      ],
      candidates: [
        {
          profileId: 'work',
          decision: 'eligible' as const,
          quotaEvidence: {
            status: 'fresh' as const,
            remainingPercent: 62,
            capturedAtMs: now - 120_000,
          },
        },
        {
          profileId: 'personal',
          decision: 'selected' as const,
          quotaEvidence: { status: 'stale_or_missing' as const },
        },
        {
          profileId: 'side',
          decision: 'excluded' as const,
          exclusionReason: 'quota_exhausted' as const,
          retryAtMs: now + 3 * HOUR,
          quotaEvidence: {
            status: 'fresh' as const,
            remainingPercent: 0,
            capturedAtMs: now - 120_000,
            exhausted: true,
          },
        },
      ],
    },
  };
  const props = bodyProps(quota, [
    {
      query,
      value: [
        {
          group,
          memberAccountIds: ['work', 'personal', 'side'],
          activeAccountId: 'personal',
          selection: {
            status: 'available',
            machineId: 'witnessed-selector',
            value: { group, observedAtMs: now, selection },
          },
        },
      ],
    },
  ]);
  comparisonHome = await serveAccountHomes({ homes: [{ key: 'a', serverUrl: 'https://usage-pool-comparison.test', accountId: 'comparison-account' }],
    route: request => request.path === '/v1/account/encryption/currentness'
      ? Response.json({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }) : undefined });
  const home = comparisonHome.homes.a!;
  publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 0 });
  const { TokenStorage } = await import('@/auth/storage/tokenStorage');
  const credentials = (await TokenStorage.getCredentialsForServerUrl(home.serverUrl))!;
  selectionTransport.mockImplementation(async (request: { payload: unknown }) => {
    const input = ConnectedServicePoolSelectionGetRequestV1Schema.parse(request.payload);
    expect(input.machineId).toBe('witnessed-selector');
    expect(input.group).toEqual(group);
    const hypothetical = { strategy: input.hypothetical!.strategy!, atMs: input.hypothetical!.atMs! };
    return { group, observedAtMs: now, hypothetical, selection: { ...selection, selected: candidate('work', 0),
      decisionTrace: { ...selection.decisionTrace, strategy: hypothetical.strategy, selectionBasis: 'preference', sticky: false,
        orderedEligibleCandidates: [candidate('work', 0), candidate('personal', 1)],
        candidates: selection.decisionTrace.candidates.map(entry => ({ ...entry,
          decision: entry.profileId === 'work' ? 'selected' : entry.profileId === 'personal' ? 'eligible' : 'excluded' })) } } };
  });
  const { UsageCapacityWidget } = await import('../UsageCapacityWidget');
  const screen = await renderScreen(
    <InjectedAuthProvider credentials={credentials}><UsageCapacityWidget {...props} serverId={home.id} id="usage_capacity" testID="cap" /></InjectedAuthProvider>,
  );
  const queue = ['personal', 'work', 'side'].map((id) =>
    screen.findHostByTestId(`cap.usedFirst.pool.${id}`),
  );
  expect(queue.every(Boolean)).toBe(true);
  // The Account's own read order is work, personal: the queue follows the selector's order instead.
  const order = screen
    .findAll(
      (node) =>
        typeof node.props.testID === 'string' &&
        /^cap\.usedFirst\.pool\.(work|personal|side)$/.test(
          node.props.testID,
        ) &&
        typeof node.type === 'string',
    )
    .map((node) => node.props.testID as string);
  expect([...new Set(order)]).toEqual([
    'cap.usedFirst.pool.personal',
    'cap.usedFirst.pool.work',
    'cap.usedFirst.pool.side',
  ]);
  expect(screen.getTextContent()).toContain('Expiring first');
  expect(screen.findByTestId('cap.usedFirst.pool.why.detail')).toBeNull();
  expect(screen.getTextContent()).not.toContain('62%');
  await screen.pressByTestIdAsync('cap.usedFirst.pool.why');
  expect(screen.findByTestId('cap.usedFirst.pool.why.detail')).toBeTruthy();
  expect(screen.findByTestId('cap.usedFirst.pool.why.comparison.strategy')).toBeTruthy();
  expect(screen.findByTestId('cap.usedFirst.pool.why.comparison.moment')).toBeTruthy();
  expect(
    screen.findByTestId('cap.usedFirst.pool.why.candidate.work'),
  ).toBeTruthy();
  // The evidence is the trace's own number (62), not the meter's (70% left).
  expect(screen.getTextContent()).toContain('62%');
  expect(
    screen.findHostByTestId('cap.usedFirst.pool.why.candidate.side')!.props
      .accessibilityLabel,
  ).toContain('used up');
  const comparison = 'cap.usedFirst.pool.why.comparison';
  const strategyControl = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${comparison}.strategy`)!;
  await act(async () => strategyControl.props.onSelect('priority'));
  await expect.poll(() => screen.findHostByTestId(`${comparison}.candidate.work`) !== null).toBe(true);
  const momentControl = screen.findAllByType(DropdownMenu).find(node => node.props.testID === `${comparison}.moment`)!;
  await act(async () => momentControl.props.onSelect(String(now + 3 * HOUR)));
  await expect.poll(() => selectionTransport.mock.calls.some(([request]) => request.payload.hypothetical.atMs === now + 3 * HOUR)).toBe(true);
  const comparisonOrder = screen.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string'
    && new RegExp(`^${comparison.replaceAll('.', '\\.')}.candidate.(work|personal|side)$`).test(node.props.testID))
    .map(node => node.props.testID);
  expect([...new Set(comparisonOrder)]).toEqual([`${comparison}.candidate.work`, `${comparison}.candidate.personal`, `${comparison}.candidate.side`]);
  // Hypothetical rows never replace the current queue or issue a mutation Action.
  expect(screen.findHostByTestId('cap.usedFirst.pool.personal')).toBeTruthy();
  expect(execute).not.toHaveBeenCalled();
});

/** One earlier week of the same record and meter in accepted history: two readings, one and three days in. */
function withEarlierWeek(read: ConnectedServiceQuotaGetResultV1, weekly: Meter): ConnectedServiceQuotaGetResultV1 {
  const current = read.current!;
  const earlierReset = weekly.resetAtMs - weekly.windowDurationMs;
  const reading = (id: string, observedAtMs: number, usedPct: number) => ({ id, observedAtMs, snapshot: { ...current,
    observedAtMs, fetchedAtMs: observedAtMs,
    meters: current.meters.map((meter) => meter.meterId === 'weekly'
      ? { ...meter, usedPct, utilizationPct: usedPct, resetAtMs: earlierReset, resetsAt: earlierReset } : meter) } });
  const start = earlierReset - weekly.windowDurationMs;
  return ConnectedServiceQuotaGetResultV1Schema.parse({ ...read, history: { nextCursor: null,
    entries: [reading('w1', start + DAY, 10), reading('w3', start + 3 * DAY, 50)] } });
}

it('charts the picked window in the same chart, labels the empirical range with its readings and discloses past cycles', async () => {
  const now = Date.now();
  const weekly: Meter = {
    meterId: 'weekly',
    label: 'Weekly',
    usedPct: 80,
    resetAtMs: now + 2 * DAY,
    windowDurationMs: 7 * DAY,
  };
  const session: Meter = {
    meterId: 'session',
    label: 'Five hour',
    usedPct: 20,
    resetAtMs: now + 2 * HOUR,
    windowDurationMs: 5 * HOUR,
  };
  const base = quotaRead('work', now, [weekly, session]);
  const recordId = base.current!.recordId;
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({
    ...base,
    unusedCapacity: {
      historyStatus: 'returned_page',
      windows: [
        {
          window: {
            recordId,
            meterId: 'weekly',
            resetAtMs: weekly.resetAtMs - 7 * DAY,
            windowStartAtMs: weekly.resetAtMs - 14 * DAY,
            windowDurationMs: 7 * DAY,
          },
          value: {
            status: 'available',
            unusedAmount: 23,
            unusedFraction: 0.23,
            unit: 'percent',
            observedAtMs: now - 5 * DAY,
            sampleCount: 5,
            qualification: 'confirmed',
            method: 'terminal_observation',
          },
        },
      ],
    },
  });
  const props = bodyProps([withEarlierWeek(read, weekly)]);
  const { UsageProjectionsWidget } = await import('../UsageProjectionsWidget');
  const screen = await renderScreen(
    wrap(
      <UsageProjectionsWidget
        {...props}
        id="usage_projections"
        testID="proj"
      />,
    ),
  );
  const chart = () =>
    screen
      .findAllByType(BurnUpChart)
      .find((node) => node.props.testID === 'proj.burnUp')!;
  const first = chart();
  await act(async () => screen.findHostByTestId('proj.burnUp')!.props.onLayout({ nativeEvent: { layout: { width: 320, height: 150 } } }));
  const band = screen.findByTestId('proj.burnUp-band-empirical-0');
  expect(band).toBeTruthy();
  expect(band!.props.d).toContain(' Z');
  expect(first.props.label).toContain('Weekly');
  // The earlier comparable week is a ghost curve on this window's axis; the spread lines are not.
  const ghosts = first.props.series.filter((entry: { id: string }) => entry.id.startsWith('earlier:'));
  expect(ghosts).toHaveLength(1);
  expect(ghosts[0].points.map((point: { x: number; y: number }) => [point.x - (weekly.resetAtMs - weekly.windowDurationMs), point.y]))
    .toEqual([[DAY, 10], [3 * DAY, 50]]);
  expect(first.props.series.some((entry: { id: string }) => entry.id === 'rangeLow')).toBe(true);
  // A pace that runs out draws to the limit and stops there, never past 100% (no "160%" scale).
  const projected = first.props.series.find((entry: { id: string }) => entry.id === 'projected');
  expect(Math.max(...projected.points.map((point: { y: number }) => point.y))).toBe(100);
  expect(projected.points.at(-1).x).toBeLessThanOrEqual(weekly.resetAtMs);
  expect(screen.findHostByTestId('proj.earlier')!.props.accessibilityLabel).toContain('1');
  const range = screen.findHostByTestId('proj.range')!.props.accessibilityLabel as string;
  // The owner's own spread (0.6–0.9 of the window at the reset) with its real reading count.
  expect(range).toContain('60%');
  expect(range).toContain('90%');
  expect(range).toContain('7');
  await screen.pressByTestIdAsync('proj.reported-header');
  expect(screen.findByTestId('proj.multiple.work.session')).toBeTruthy();
  expect(screen.findByTestId('proj.pastCycles.row.0')).toBeNull();
  await screen.pressByTestIdAsync('proj.pastCycles-header');
  // 1 − 0.23 unused: the ended window's recorded used share.
  expect(
    screen.findHostByTestId('proj.pastCycles.row.0')!.props.accessibilityLabel,
  ).toContain('77%');
  const picker = screen
    .findAllByType(DropdownMenu)
    .find((node) => node.props.testID === 'proj.windowPicker')!;
  expect(
    picker.props.items.map((item: { id: string }) => item.id),
  ).toHaveLength(2);
  const sessionKey = picker.props.items.find((item: { title: string }) =>
    item.title.includes('Five hour'),
  ).id;
  await act(async () => picker.props.onSelect(sessionKey));
  expect(chart().props.label).toContain('Five hour');
  expect(chart()).toBe(first);
});

it("binds one Session's pending message to a reset with the exact witnessed input, and withholds the control without a witness", async () => {
  const now = Date.now();
  const runtime = await import('@/sync/domains/server/serverRuntime');
  const server = await runtime.upsertAndActivateServer({
    serverUrl: 'http://usage-plans.test',
    name: 'Plans',
  });
  publishAppliedActiveServerSnapshot(runtime.getActiveServerSnapshot());
  const previous = storage.getState();
  storage.setState({
    profileScope: { serverId: server.id, accountId: 'account-a' },
    sessionPending: {
      ...previous.sessionPending,
      s1: {
        messages: [
          {
            id: 'p1',
            localId: 'local-1',
            createdAt: now,
            updatedAt: now,
            text: 'Run the big refactor',
            rawRecord: null,
          },
        ],
        discarded: [],
        isLoaded: true,
      },
    },
  } as Partial<typeof previous> as typeof previous);
  try {
    const weekly: Meter = {
      meterId: 'weekly',
      label: 'Weekly',
      usedPct: 80,
      resetAtMs: now + 2 * DAY,
      windowDurationMs: 7 * DAY,
    };
    const bare = quotaRead('work', now, [weekly]);
    const witnessed = ConnectedServiceQuotaGetResultV1Schema.parse({
      ...bare,
      history: {
        nextCursor: null,
        entries: [{ id: 'entry-9', observedAtMs: now, snapshot: bare.current }],
      },
    });
    const sessionQuery = normalizeUsageQuery({ session: 's1' });
    const { UsageResetPlannerWidget } =
      await import('../UsageResetPlannerWidget');
    const none = await renderScreen(
      wrap(
        <UsageResetPlannerWidget
          {...bodyProps([bare], undefined, sessionQuery)}
          serverId={server.id}
          id="usage_resets"
          testID="reset"
        />,
      ),
    );
    expect(none.findByTestId('reset.resetStart.unavailable')).toBeTruthy();
    expect(
      none
        .findAllByType(DropdownMenu)
        .some((node) => node.props.testID === 'reset.resetStart.local-1.pick'),
    ).toBe(false);
    await none.unmount();
    execute.mockResolvedValue({
      ok: true,
      result: { didUpdate: true, requestedAction: { v: 1, kind: 'enqueue' } },
    });
    const screen = await renderScreen(
      wrap(
        <UsageResetPlannerWidget
          {...bodyProps([witnessed], undefined, sessionQuery)}
          serverId={server.id}
          id="usage_resets"
          testID="reset"
        />,
      ),
    );
    const picker = screen
      .findAllByType(DropdownMenu)
      .find((node) => node.props.testID === 'reset.resetStart.local-1.pick')!;
    await act(async () => {
      picker.props.onSelect(picker.props.items[0].id);
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toBe('session.pending.resetStart.set');
    expect(execute.mock.calls[0]![1]).toEqual({
      sessionId: 's1',
      localId: 'local-1',
      serverId: server.id,
      reset: {
        source: witnessed.source,
        recordId: witnessed.current!.recordId,
        meterId: 'weekly',
        witness: { id: 'entry-9', observedAtMs: now },
      },
    });
  } finally {
    storage.setState({
      profileScope: previous.profileScope,
      sessionPending: previous.sessionPending,
    });
  }
});

it('binds Account-wide queued identities once across accounts without reading private Pending text or granting unavailable authority', async () => {
  const now = Date.now();
  const runtime = await import('@/sync/domains/server/serverRuntime');
  const server = await runtime.upsertAndActivateServer({ serverUrl: 'http://usage-account-plans.test', name: 'Plans' });
  publishAppliedActiveServerSnapshot(runtime.getActiveServerSnapshot());
  const previous = storage.getState();
  const privateText = 'Private queued request';
  storage.setState({
    profileScope: { serverId: server.id, accountId: 'account-a' },
    sessionPending: {
      ...previous.sessionPending,
      s1: { messages: [{ id: 'p1', localId: 'local-1', createdAt: now, updatedAt: now, text: privateText, rawRecord: null }], discarded: [], isLoaded: true },
    },
  });
  try {
    const unboundEntries = [
      { sessionId: 's1', localId: 'local-1', authorityCurrent: true },
      { sessionId: 's2', localId: 'local-1', authorityCurrent: false },
    ];
    const reads = ['work', 'personal'].map(accountId => {
      const bare = quotaRead(accountId, now, [{ meterId: 'weekly', label: 'Weekly', usedPct: 80, resetAtMs: now + 2 * DAY, windowDurationMs: 7 * DAY }]);
      return ConnectedServiceQuotaGetResultV1Schema.parse({
        ...bare,
        history: { nextCursor: null, entries: [{ id: `accepted-${accountId}`, observedAtMs: now, snapshot: bare.current }] },
        waitingWork: { status: 'available', entries: [], unboundEntries },
      });
    });
    execute.mockResolvedValue({ ok: true, result: { didUpdate: true, requestedAction: { v: 1, kind: 'enqueue' } } });
    const { UsageResetPlannerWidget } = await import('../UsageResetPlannerWidget');
    const screen = await renderScreen(wrap(<UsageResetPlannerWidget {...bodyProps(reads)} serverId={server.id} id="usage_resets" testID="reset" />));
    const pickers = screen.findAllByType(DropdownMenu).filter(node => String(node.props.testID).startsWith('reset.resetStart.'));
    expect(pickers).toHaveLength(2);
    expect(screen.getTextContent()).not.toContain(privateText);
    const available = pickers.find(node => node.props.testID === 'reset.resetStart.s1.local-1.pick')!;
    const unavailable = pickers.find(node => node.props.testID === 'reset.resetStart.s2.local-1.pick')!;
    expect(screen.findByTestId('reset.resetStart.s2.local-1.open')!.props.disabled).toBe(true);
    await act(async () => {
      unavailable.props.onSelect(unavailable.props.items[0].id);
      await Promise.resolve();
    });
    expect(execute).not.toHaveBeenCalled();
    await act(async () => {
      available.props.onSelect(available.props.items[0].id);
      await Promise.resolve();
    });
    expect(execute).toHaveBeenCalledWith('session.pending.resetStart.set', {
      sessionId: 's1', localId: 'local-1', serverId: server.id,
      reset: { source: reads[0]!.source, recordId: reads[0]!.current!.recordId, meterId: 'weekly', witness: { id: 'accepted-work', observedAtMs: now } },
    }, expect.objectContaining({ expectedAccountId: 'account-a', serverId: server.id }));
  } finally {
    storage.setState({ profileScope: previous.profileScope, sessionPending: previous.sessionPending });
  }
});

it("says what a banked reset's expiry means against the natural reset, and counts plan fit over witnessed windows only", async () => {
  const now = Date.now();
  const weekly: Meter = {
    meterId: 'weekly',
    label: 'Weekly',
    usedPct: 80,
    resetAtMs: now + 2 * DAY,
    windowDurationMs: 7 * DAY,
  };
  const base = quotaRead(
    'work',
    now,
    [weekly],
    {},
    {
      recoveryCredits: {
        availableCount: 1,
        nextExpiresAtMs: now + DAY,
        credits: [
          {
            kind: 'usage_limit_reset',
            status: 'available',
            expiresAtMs: now + DAY,
          },
        ],
      },
    },
  );
  const recordId = base.current!.recordId;
  const ended = (weeks: number, unusedFraction: number) => ({
    window: {
      recordId,
      meterId: 'weekly',
      resetAtMs: weekly.resetAtMs - weeks * 7 * DAY,
      windowStartAtMs: weekly.resetAtMs - (weeks + 1) * 7 * DAY,
      windowDurationMs: 7 * DAY,
    },
    value: {
      status: 'available',
      unusedAmount: unusedFraction * 100,
      unusedFraction,
      unit: 'percent',
      observedAtMs: now - weeks * 7 * DAY,
      sampleCount: 3,
      qualification: 'confirmed',
      method: 'terminal_observation',
    },
  });
  const read = ConnectedServiceQuotaGetResultV1Schema.parse({
    ...base,
    unusedCapacity: {
      historyStatus: 'returned_page',
      windows: [ended(1, 0), ended(2, 0.4), ended(3, 0.5)],
    },
  });
  const { UsageResetPlannerWidget } =
    await import('../UsageResetPlannerWidget');
  const resets = await renderScreen(
    wrap(
      <UsageResetPlannerWidget
        {...bodyProps([read])}
        id="usage_resets"
        testID="reset"
      />,
    ),
  );
  expect(
    resets.findHostByTestId('reset.wallet.work.advice')!.props.children,
  ).toBeTruthy();
  expect(resets.findByTestId('reset.list.0')).toBeTruthy();
  expect(resets.findHostByTestId('reset.resetStart')).toBeNull();
  await resets.unmount();
  const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
  const fit = await renderScreen(
    wrap(
      <UsagePlanFitWidget
        {...bodyProps([read, quotaRead('other', now, [weekly])])}
        id="usage_plan_fit"
        testID="fit"
      />,
    ),
  );
  const label = fit.findHostByTestId('fit.plan.work.fit')!.props
    .accessibilityLabel as string;
  expect(label).toContain('1');
  expect(label).toContain('3');
  expect(fit.findByTestId('fit.plan.other.fit.insufficient')).toBeTruthy();
  expect(fit.findByTestId('fit.notRecorded')).toBeTruthy();
});

it('shows the list-price observation date in the selected app language', async () => {
  const previousLanguage = getPreferredLanguage();
  const appLanguage = new Intl.DateTimeFormat().resolvedOptions().locale.startsWith('fr') ? 'de' : 'fr';
  await preloadTranslationsForSettings(appLanguage);
  setPreferredLanguageFromSettings(appLanguage);
  try {
    const now = Date.now();
    const asOfMs = now - 30 * DAY;
    const period = { startAtMs: now - DAY, endAtMs: now + 2 * DAY };
    const read = quotaRead('work', now, [], {}, {
      subscription: {
        status: 'subscribed', renewal: 'on', observedAtMs: now, staleAfterMs: HOUR,
        currentPeriodStartAtMs: period.startAtMs, currentPeriodEndAtMs: period.endAtMs,
        monetaryFacts: [{
          kind: 'list', amount: 20, currency: 'USD', period,
          source: { kind: 'published', id: 'provider-list', version: '2026-09' },
          effectiveAtMs: asOfMs, asOfMs,
        }],
      },
    });
    const { UsagePlanFitWidget } = await import('../UsagePlanFitWidget');
    const screen = await renderScreen(wrap(
      <UsagePlanFitWidget {...bodyProps([read])} id="usage_plan_fit" testID="fit" />,
    ));
    const options = { day: 'numeric', month: 'short', year: 'numeric' } as const;
    const expected = new Intl.DateTimeFormat(appLanguage, options).format(asOfMs);
    const deviceDate = new Intl.DateTimeFormat(undefined, options).format(asOfMs);
    expect(expected).not.toBe(deviceDate);
    expect(screen.findHostByTestId('fit.plan.work')!.props.accessibilityLabel).toContain(expected);
  } finally {
    setPreferredLanguageFromSettings(previousLanguage);
  }
});
