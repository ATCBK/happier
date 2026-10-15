import * as React from 'react';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import { View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import type { UsageBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';
import type {
  UsageQueryResultSlice,
  UsageQuerySourceState,
} from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { USAGE_METER_METRICS } from '@/components/settings/connectedServices/usage/UsageMeterRow';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { HappierSkeletonBlock } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import {
  buildUsageAnalyticsViewModel,
  type UsageAnalyticsViewModel,
} from '@/sync/api/account/usageAnalytics';
import { getPreferredLanguage, t, type TranslationKeyNoParams } from '@/text';
import { projectUsagePageCost } from '@happier-dev/protocol/usage/usageCostFacts';
import { wasConnectedServiceQuotaObserved } from '@happier-dev/protocol/connect/quotaObservationTime';
import { type UsagePageCostProjection, type UsageAnalyticsCoverage } from '@happier-dev/protocol';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';
import { formatUsageCalendarPeriod, formatUsageObservedAt } from '@/sync/domains/usage/usageCalendarPresentation';
import { usageSourceTitle } from '@/sync/domains/usage/usageLabels';
export { usageSourceTitle, usageAgentTitle, usageDimensionLabel } from '@/sync/domains/usage/usageLabels';
import { useUsageWidgetPageHasCoverageDetail } from './usageWidgetBatch';
import { useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { projectProjectListV1 } from '@happier-dev/protocol/workspaces';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';

/** What every Usage body receives from the one dispatcher: admitted facts, never a fetch handle. */
export type UsageBodyProps = Readonly<{
  id: UsageBuiltinWidgetIdV1;
  model: UsageWidgetBodyModel;
  slice: UsageQueryResultSlice;
  /** The query these facts answer (the shown one while a period change settles). */
  query: UsageQuery;
  serverId: string;
  testID: string;
}>;

export function useUsagePluginTheme(): PluginUiThemeV1 {
  const { theme } = useUnistyles();
  return React.useMemo(() => projectPluginUiTheme(theme), [theme]);
}

/** Exact shown dates; a date range does not establish a rolling preset identity. */
export function usagePeriodPhrase(query: Pick<UsageQuery, 'period' | 'timeZoneOffsetMinutes'>): string {
  return formatUsageCalendarPeriod({ ...query.period, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes });
}

// One projection per admitted accounting response and presentation; bodies share it, never rebuild it.
type UsageBodyAnalyticsView = UsageAnalyticsViewModel & Readonly<{ pageCost: UsagePageCostProjection }>;
const viewModels = new WeakMap<object, Map<string, UsageBodyAnalyticsView>>();

/** Names stay in the opened Account projection; accounting carries only the Project anchor. */
export function useUsageProjectLabels(serverId: string): ReadonlyMap<string, string> {
  const rows = useProjectAccountRows();
  return React.useMemo(() => {
    const labels = new Map<string, string>();
    if (!rows || rows.status === 'locked' || rows.status === 'refused'
      || !areServerProfileIdentifiersEquivalent(rows.scope.serverId, serverId)) return labels;
    const projection = projectProjectListV1({ serverId, workspaceRefs: rows.workspaceRefs,
      organizations: rows.organizations, normalizeServerId: resolveServerProfileScopeIdForIdentifier });
    for (const group of [...projection.projectGroups, ...projection.hiddenProjectGroups]) {
      const ref = group.items[0];
      if (ref) labels.set(group.projectKey.projectKey, resolveWorkspaceRefDisplayName(ref));
    }
    // The opened snapshot supplies Home/Account authority. Native opaque keys
    // retain their producing CLI profile namespace, which is not a UI Home id
    // or routing grant; join those keys only within this admitted snapshot.
    for (const row of rows.organizations) {
      if (row.value.label) labels.set(row.key.projectKey, row.value.label);
    }
    return labels;
  }, [rows, serverId]);
}

/** The incumbent UI projection of A facts for this slice (A owns the numbers, this only shapes them). */
export function useUsageAnalyticsView(
  slice: UsageQueryResultSlice,
  query: UsageQuery,
): UsageBodyAnalyticsView | null {
  const accounting = slice.accounting;
  const language = getPreferredLanguage();
  return React.useMemo(() => {
    if (!accounting) return null;
    const key = `${query.metric}\u0000${query.costBasis}\u0000${query.timeZoneOffsetMinutes ?? 0}\u0000${language}`;
    let byKey = viewModels.get(accounting);
    if (!byKey) {
      byKey = new Map();
      viewModels.set(accounting, byKey);
    }
    const cached = byKey.get(key);
    if (cached) return cached;
    const analytics = buildUsageAnalyticsViewModel(
      accounting,
      // The response already carries the admitted range; the legacy array filter is unused here.
      { period: 'all', metric: query.metric, costMode: query.costBasis, focus: null },
      query.timeZoneOffsetMinutes ?? 0,
    );
    const built = { ...analytics, pageCost: analytics.pageCost ?? projectUsagePageCost(accounting, query.costBasis) };
    byKey.set(key, built);
    return built;
  }, [
    accounting,
    query.metric,
    query.costBasis,
    query.timeZoneOffsetMinutes,
    language,
  ]);
}

/**
 * A supported, visible result for a fact this query cannot answer yet. It says what is missing and
 * why; it never draws zero.
 */
/**
 * A first read that has not answered yet holds the body's room with the shared skeleton, in the shape of
 * what lands (a figure, its meter, a caption line); it never reads as "none" (lab kitstates "Loading ·
 * first time"). The page header already says what is still being read.
 */
export function UsageBodyReading(props: Readonly<{
  testID: string;
  /**
   * The body's known shape, so the room it will fill is held from the first frame: `meters` rows of a
   * name, a bar and a caption (a list of allowance windows), or the `mix` of two figures over a strip.
   */
  shape?: Readonly<{ kind: 'meters'; rows: number }> | Readonly<{ kind: 'mix' }> | Readonly<{ kind: 'summary' }> | Readonly<{ kind: 'strip' }>;
}>) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const color = theme.colors.surface.pressedOverlay;
  const shape = props.shape;
  if (shape?.kind === 'meters') {
    return (
      <View testID={props.testID} style={readingStyles.meters}>
        {Array.from({ length: Math.max(1, shape.rows) }, (_, index) => (
          <View key={index} style={readingStyles.meter}>
            <HappierSkeletonBlock color={color} width="46%" height={12} radius={4} reducedMotion={reducedMotion} />
            <HappierSkeletonBlock color={color} width="100%" height={6} radius={3} reducedMotion={reducedMotion} />
            <HappierSkeletonBlock color={color} width="22%" height={10} radius={4} reducedMotion={reducedMotion} />
          </View>
        ))}
      </View>
    );
  }
  if (shape?.kind === 'mix') {
    return (
      <View testID={props.testID} style={readingStyles.mix}>
        <View style={readingStyles.mixFigures}>
          {[0, 1].map((index) => (
            <View key={index} style={readingStyles.mixFigure}>
              <HappierSkeletonBlock color={color} width="50%" height={10} radius={4} reducedMotion={reducedMotion} />
              <HappierSkeletonBlock color={color} width="38%" height={22} radius={6} reducedMotion={reducedMotion} />
              <HappierSkeletonBlock color={color} width="70%" height={10} radius={4} reducedMotion={reducedMotion} />
            </View>
          ))}
        </View>
        <HappierSkeletonBlock color={color} width="100%" height={14} radius={5} reducedMotion={reducedMotion} />
        <HappierSkeletonBlock color={color} width="60%" height={10} radius={4} reducedMotion={reducedMotion} />
      </View>
    );
  }
  if (shape?.kind === 'strip') {
    return (
      <View testID={props.testID} style={readingStyles.strip}>
        {[0, 1, 2].map((index) => (
          <View key={index} style={readingStyles.stripColumn}>
            <HappierSkeletonBlock color={color} width="34%" height={10} radius={4} reducedMotion={reducedMotion} />
            <HappierSkeletonBlock color={color} width="86%" height={14} radius={4} reducedMotion={reducedMotion} />
            <HappierSkeletonBlock color={color} width="100%" height={10} radius={4} reducedMotion={reducedMotion} />
            <HappierSkeletonBlock color={color} width="62%" height={10} radius={4} reducedMotion={reducedMotion} />
          </View>
        ))}
      </View>
    );
  }
  if (shape?.kind === 'summary') {
    return (
      <View testID={props.testID} style={readingStyles.summary}>
        <View style={readingStyles.summaryHero}>
          <HappierSkeletonBlock color={color} width="30%" height={10} radius={4} reducedMotion={reducedMotion} />
          <HappierSkeletonBlock color={color} width="34%" height={34} radius={8} reducedMotion={reducedMotion} />
          <HappierSkeletonBlock color={color} width="52%" height={12} radius={4} reducedMotion={reducedMotion} />
        </View>
        <View style={readingStyles.summaryStats}>
          {[0, 1, 2].map((index) => (
            <View key={index} style={readingStyles.summaryStat}>
              <HappierSkeletonBlock color={color} width="40%" height={10} radius={4} reducedMotion={reducedMotion} />
              <HappierSkeletonBlock color={color} width="62%" height={22} radius={6} reducedMotion={reducedMotion} />
              <HappierSkeletonBlock color={color} width="84%" height={12} radius={4} reducedMotion={reducedMotion} />
            </View>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View testID={props.testID} style={readingStyles.body}>
      <HappierSkeletonBlock color={color} width="28%" height={28} radius={6} reducedMotion={reducedMotion} />
      <HappierSkeletonBlock color={color} width="100%" height={8} radius={4} reducedMotion={reducedMotion} />
      <HappierSkeletonBlock color={color} width="56%" height={12} radius={4} reducedMotion={reducedMotion} />
    </View>
  );
}

const SETTLED_SUMMARY_BODY_PX = 152;
/** The Coach's Overview strip with its findings in (one row of three columns) measures this tall. */
export const SETTLED_COACH_STRIP_BODY_PX = 118;
const readingStyles = StyleSheet.create(() => ({
  body: { gap: 12, paddingVertical: 4 },
  meters: { gap: USAGE_METER_METRICS.rowGapPx, paddingVertical: 4 },
  meter: { gap: 8 },
  mix: { gap: 18, paddingVertical: 4 },
  mixFigures: { flexDirection: 'row', columnGap: 24 },
  mixFigure: { flex: 1, gap: 8 },
  // The Period summary's settled body (a hero, its line, three captioned figures) measures this tall.
  summary: { minHeight: SETTLED_SUMMARY_BODY_PX, gap: 20 },
  summaryHero: { gap: 8 },
  // The same wrap as the figures themselves (UsagePeriodSummaryWidget), so a narrow card holds two rows too.
  summaryStats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 16 },
  summaryStat: { flexGrow: 1, flexBasis: 120, minWidth: 0, gap: 8 },
  strip: { minHeight: SETTLED_COACH_STRIP_BODY_PX, flexDirection: 'row', columnGap: 36, paddingVertical: 4 },
  stripColumn: { flex: 1, gap: 10 },
}));

/** True while every read a body depends on is still outstanding (pending or not yet loaded). */
export function isUsageReadOutstanding(slice: UsageQueryResultSlice, sources: readonly string[]): boolean {
  const gaps = readUsageCoverageGaps(slice, sources);
  return gaps.length > 0 && gaps.every(gap => gap.status === 'pending' || gap.status === 'not_loaded');
}

/** "No usage in this period" only once the usage read answered; until then the body is loading. */
export function UsageBodyNoUsage(props: Readonly<{
  slice: UsageQueryResultSlice;
  testID: string;
  /** The shape the body will take, so its first read holds that room. */
  readingShape?: React.ComponentProps<typeof UsageBodyReading>['shape'];
}>) {
  if (isUsageReadOutstanding(props.slice, ['accounting']))
    return <UsageBodyReading testID={`${props.testID}.loading`} {...(props.readingShape ? { shape: props.readingShape } : {})} />;
  return (
    <UsageBodyInsufficient
      testID={`${props.testID}.empty`}
      title={t('usage.board.page.noUsageTitle')}
      reason={t('usage.board.page.noUsageReason')}
    />
  );
}

export function UsageBodyInsufficient(
  props: Readonly<{
    title: string;
    reason?: string;
    testID: string;
    /** False for an insufficient sub-section beside admitted facts. */
    replacesContent?: boolean;
    action?: Readonly<{ label: string; onPress: () => void }>;
  }>,
) {
  return (
    <SurfaceStateCard
      testID={props.testID}
      kind="empty"
      replacesContent={props.replacesContent !== false}
      layout="inline"
      size="line"
      title={props.title}
      {...(props.reason ? { reason: props.reason } : {})}
      {...(props.action
        ? {
            action: {
              label: props.action.label,
              onPress: props.action.onPress,
            },
          }
        : {})}
    />
  );
}

const COVERAGE_REASON_KEYS = {
  missing_baseline: 'usage.board.page.coverageReason_missing_baseline',
  counter_discontinuity: 'usage.board.page.coverageReason_counter_discontinuity',
  ambiguous_overlap: 'usage.board.page.coverageReason_ambiguous_overlap',
  unattributed_model: 'usage.board.page.coverageReason_unattributed_model',
  unpriced_tokens: 'usage.board.page.coverageReason_unpriced_tokens',
  unknown_source: 'usage.board.page.coverageReason_unknown_source',
  incomplete_history: 'usage.board.page.coverageReason_incomplete_history',
  ranked_truncation: 'usage.board.page.coverageReason_ranked_truncation',
  unknown_token_categories: 'usage.board.page.coverageReason_unknown_token_categories',
} satisfies Record<UsageAnalyticsCoverage['reasons'][number], TranslationKeyNoParams>;

/** Sources this body depends on that are not complete, worded once under the content. */
export function readUsageCoverageGaps(
  slice: UsageQueryResultSlice,
  sources: readonly string[],
): readonly UsageQuerySourceState[] {
  const accounting = sources.includes('accounting') ? slice.accounting?.coverage : undefined;
  const dependent = new Set([...sources, ...(accounting?.sources.map(source => source.source) ?? [])]);
  const quotaRequested = sources.includes('quota');
  const gaps = slice.sources.filter(source => (dependent.has(source.source)
    || quotaRequested && source.source.startsWith('quota:')) && source.status !== 'available');
  // Transport settlement does not establish history completeness. Keep the
  // settled allowance's qualification visible between refreshes as well.
  if (quotaRequested && slice.quota?.some(read => read.history?.nextCursor != null
    || read.unusedCapacity && read.unusedCapacity.historyStatus !== 'returned_page')
    && !gaps.some(source => source.source === 'quota')) {
    const clocks = slice.quota.flatMap(read => read.current && wasConnectedServiceQuotaObserved(read.current)
      ? [read.current.fetchedAtMs] : []);
    gaps.push({ source: 'quota', status: 'partial', ...(clocks.length ? { asOfMs: Math.min(...clocks) } : {}) });
  }
  if (sources.includes('accounting') && slice.accounting && !accounting
    && !gaps.some(source => source.source === 'accounting')) {
    gaps.unshift({ source: 'accounting', status: 'unknown' });
  }
  if (accounting && (accounting.status !== 'complete' || accounting.range.complete !== true || accounting.reasons.length > 0)
    && !gaps.some(source => source.source === 'accounting')) {
    gaps.unshift({ source: 'accounting', status: accounting.status === 'complete' ? 'partial' : accounting.status });
  }
  const unique = new Map<string, UsageQuerySourceState>();
  const severity = { available: 0, unsupported: 1, unknown: 2, stale: 3, partial: 4, not_loaded: 5, pending: 6, error: 7 };
  for (const gap of gaps) {
    const previous = unique.get(gap.source);
    if (!previous) { unique.set(gap.source, gap); continue; }
    const worst = severity[gap.status] > severity[previous.status] ? gap : previous;
    const dates = [previous.asOfMs, gap.asOfMs].filter((date): date is number => date !== undefined);
    unique.set(gap.source, { ...worst, ...(dates.length ? { asOfMs: Math.min(...dates) } : {}) });
  }
  return [...unique.values()];
}

function usageCoverageHeadlineKey(gaps: readonly Pick<UsageQuerySourceState, 'status'>[]) {
  return gaps.some(gap => gap.status === 'error') ? 'usage.board.page.coverageFailed' as const
    : gaps.every(gap => gap.status === 'pending' || gap.status === 'not_loaded') ? 'usage.board.page.coveragePending' as const
      : 'usage.board.page.coveragePartial' as const;
}

/**
 * The one quiet clause a body's own line carries when its host has no Sources detail (Home, a Board): a read
 * still going or failed names its sources (a failure with its Retry); an incomplete read says only "Partial
 * history", never a paragraph of sources and reasons. The full wording is `usageCoverageDescription`.
 */
export function usageCoverageSummary(slice: UsageQueryResultSlice, sources: readonly string[]): string {
  const gaps = readUsageCoverageGaps(slice, sources);
  if (!gaps.length) return '';
  const key = usageCoverageHeadlineKey(gaps);
  if (key === 'usage.board.page.coveragePartial') return usagePartialHistoryLabel();
  return usageCoverageDescription(slice, sources);
}

/** "Partial history": the whole of what a body's quiet line says about an incomplete read. */
export function usagePartialHistoryLabel(): string {
  const text = t('usage.board.page.factIncomplete');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One wording owner for the page's Sources chooser and the failed or pending line. */
export function usageCoverageDescription(slice: UsageQueryResultSlice, sources: readonly string[]): string {
  const gaps = readUsageCoverageGaps(slice, sources);
  if (!gaps.length) return '';
  const names = [...new Set(gaps.map(gap => gap.status === 'unsupported'
    ? `${usageSourceTitle(gap.source)} (${t('usage.board.sources.unsupported')})` : usageSourceTitle(gap.source)))].join(', ');
  const key = usageCoverageHeadlineKey(gaps);
  const reasons = sources.includes('accounting')
    ? [...new Set(slice.accounting?.coverage?.reasons ?? [])].map(reason => t(COVERAGE_REASON_KEYS[reason])) : [];
  return [t(key, { sources: names }), ...reasons].join(' · ');
}

export type UsageCoverageLineMode = 'hidden' | 'failed' | 'detail';

/**
 * Coverage is said once per surface. On the Usage page the Sources chooser carries the one quiet dot
 * and its detail, and the page header says once what is still being read, so a body keeps a line only
 * for a failed read (with Retry). Hosts without those page indicators keep the full detail line.
 */
export function usageCoverageLineMode(gaps: readonly Pick<UsageQuerySourceState, 'status'>[], pageHasDetail: boolean): UsageCoverageLineMode {
  if (gaps.length === 0) return 'hidden';
  if (gaps.some(gap => gap.status === 'error')) return pageHasDetail ? 'failed' : 'detail';
  return pageHasDetail ? 'hidden' : 'detail';
}

/** The page header's one "Still reading …" fact: every source any view's read still waits on, named once. */
const USAGE_PAGE_READ_SOURCES: ReadonlySet<string> = new Set(['accounting', 'quota', 'work', 'how_you_work']);

export function readUsagePageAsOfMs(slices: readonly Pick<UsageQueryResultSlice, 'sources' | 'quota'>[]): number | null {
  // Older observations retain their own dates in source detail. The page names
  // its latest witnessed update, never the oldest historical source in a total.
  let latest: number | null = null;
  for (const slice of slices) {
    for (const source of slice.sources) {
      if (source.asOfMs !== undefined) latest = latest === null ? source.asOfMs : Math.max(latest, source.asOfMs);
    }
    // A refresh can retain individual account facts before its qualified source
    // rows arrive. The aggregate quota date deliberately remains conservative.
    for (const read of slice.quota ?? []) {
      if (read.current && wasConnectedServiceQuotaObserved(read.current)) {
        latest = latest === null ? read.current.fetchedAtMs : Math.max(latest, read.current.fetchedAtMs);
      }
    }
  }
  return latest;
}

export function describeUsagePagePendingSources(slices: readonly Pick<UsageQueryResultSlice, 'sources'>[]): string | null {
  // Only the page's shared reads; a widget's own read (a pool selection) is said by that widget.
  const names = [...new Set(slices.flatMap(slice => slice.sources
    // Not loaded also describes intentionally undemanded private evidence.
    // Only its producer's pending state establishes that a read is in flight.
    .filter(source => source.status === 'pending')
    // A sibling can already supply the aggregate quota while this account is still being read.
    // Keep qualified identity at the Resource; the shared header names its read family only once.
    .map(source => source.source.startsWith('quota:') ? 'quota' : source.source)
    .filter(source => USAGE_PAGE_READ_SOURCES.has(source))
    .map(source => usageSourceTitle(source))))];
  return names.length ? t('usage.board.page.coveragePending', { sources: names.join(', ') }) : null;
}

export function UsageCoverageLine(
  props: Readonly<{
    slice: UsageQueryResultSlice;
    sources: readonly string[];
    onRetry?: () => void | Promise<unknown>;
    testID: string;
  }>,
) {
  const pageHasDetail = useUsageWidgetPageHasCoverageDetail();
  const gaps = readUsageCoverageGaps(props.slice, props.sources);
  const mode = usageCoverageLineMode(gaps, pageHasDetail);
  if (mode === 'hidden') return null;
  const failed = mode === 'failed' || gaps.some((gap) => gap.status === 'error');
  if (mode === 'failed') {
    // One short line: what failed, with its Retry; the detail is in Sources.
    const names = [...new Set(gaps.filter(gap => gap.status === 'error').map(gap => usageSourceTitle(gap.source)))].join(', ');
    return (
      <SurfaceFreshnessLine
        testID={props.testID}
        tone="warning"
        reason={t('usage.board.page.coverageFailed', { sources: names })}
        {...(props.onRetry ? { action: { label: t('common.retry'), onPress: props.onRetry } } : {})}
      />
    );
  }
  const pending = gaps.every(
    (gap) => gap.status === 'pending' || gap.status === 'not_loaded',
  );
  const asOf = gaps.reduce<number | null>(
    (oldest, gap) =>
      gap.asOfMs === undefined
        ? oldest
        : oldest === null
          ? gap.asOfMs
          : Math.min(oldest, gap.asOfMs),
    null,
  );
  return (
    <SurfaceFreshnessLine
      testID={props.testID}
      busy={pending}
      tone={failed ? 'warning' : 'neutral'}
      reason={[...(asOf === null ? [] : [t('surfaceState.asOf', { time: formatUsageObservedAt(asOf) })]), usageCoverageSummary(props.slice, props.sources)].join(' · ')}
      {...(failed && props.onRetry
        ? { action: { label: t('common.retry'), onPress: props.onRetry } }
        : {})}
    />
  );
}

/** The Agent's catalog mark, standing on its own (no tile), in ink. */
export function UsageAgentMark(props: Readonly<{ agentId: string; serverId: string | null; size?: number; color?: string }>) {
    const entry = React.useMemo(() => { try { return resolveAgentCatalogProjection(props.agentId, { enabledAgentIds: [] }); } catch { return null; } }, [props.agentId]);
    if (!entry) return null;
    return <AgentCatalogIdentityIcon entry={entry} machineId={null} serverId={props.serverId} current={false}
        size={props.size ?? ICON_SIZE.sm} {...(props.color ? { color: props.color } : {})} />;
}

/** A list leads with its largest rows; a long tail stays one press away, never a wall. */
const LEADING_ROWS = 6;
/** A tail this short is shown whole: a disclosure for a row or two is only noise. */
const SHORT_TAIL_ROWS = 2;

export function leadingUsageRows<Row>(rows: readonly Row[], expanded: boolean): Readonly<{ rows: readonly Row[]; hidden: number }> {
  if (expanded || rows.length <= LEADING_ROWS + SHORT_TAIL_ROWS) return { rows, hidden: 0 };
  return { rows: rows.slice(0, LEADING_ROWS), hidden: rows.length - LEADING_ROWS };
}

/** An allowance account reports a session and a longer window; this only sizes the room held while reads arrive. */
const EXPECTED_WINDOWS_PER_ACCOUNT = 2;
/** What the settled list measures: a captioned meter row, the Show all button, one quiet line, the body's row gap. */
const SETTLED_ROW_PX = 43;
const SETTLED_SHOW_ALL_PX = 26;
const SETTLED_QUIET_LINE_PX = 18;
const SETTLED_BODY_GAP_PX = 16;
/** The quiet lines that can close a led list: the unreported-windows note (one line) and the pace legend (two on a phone). */
const SETTLED_LEGEND_LINES = { wide: 1, narrow: 2 } as const;
/** The pace alert ("runs out Thu 02:26 AM before it resets") sits among them and wraps to two lines at a half-width. */
const SETTLED_PACE_NOTE_LINES = 2;

/**
 * The room a list of allowance windows holds while their reads still arrive, from the accounts already
 * known: rows fill it and the notes under them join it, so nothing below the list moves until the
 * reads settle. Undefined when no allowance read is outstanding or no account is known yet.
 */
export function readUsageMeterListReserve(slice: UsageQueryResultSlice, accountCount: number, narrow = false): Readonly<{
  shape: Extract<NonNullable<React.ComponentProps<typeof UsageBodyReading>['shape']>, { kind: 'meters' }>;
  minHeight: number;
}> | undefined {
  const outstanding = readUsageCoverageGaps(slice, ['quota']).some(gap => gap.status === 'pending' || gap.status === 'not_loaded');
  if (!outstanding || accountCount < 1) return undefined;
  const led = leadingUsageRows(Array.from({ length: accountCount * EXPECTED_WINDOWS_PER_ACCOUNT }), false);
  const rows = led.rows.length;
  const gap = SETTLED_BODY_GAP_PX;
  const minHeight = rows * SETTLED_ROW_PX + (rows - 1) * USAGE_METER_METRICS.rowGapPx
    + (led.hidden > 0 ? gap + SETTLED_SHOW_ALL_PX : 0)
    + (gap + SETTLED_QUIET_LINE_PX)
    + gap + SETTLED_LEGEND_LINES[narrow ? 'narrow' : 'wide'] * SETTLED_QUIET_LINE_PX
    + gap + SETTLED_PACE_NOTE_LINES * SETTLED_QUIET_LINE_PX;
  return { shape: { kind: 'meters', rows }, minHeight };
}

/**
 * The list's first-read room: held from the first frame until every account has answered once, through the
 * reads' arrivals, so the pace alert, its shared reason and the legend come and go inside it and the body
 * settles its height once. After that settle a re-read never reserves again, so it cannot add blank room
 * under retained rows. Nothing is held before the read's accounts are known.
 */
export function useUsageMeterListFirstReadReserve(
  slice: UsageQueryResultSlice,
  accountCount: number,
  everyAccountAnswered: boolean,
  narrow: boolean,
): ReturnType<typeof readUsageMeterListReserve> {
  const settledOnce = React.useRef(false);
  if (everyAccountAnswered) settledOnce.current = true;
  return settledOnce.current ? undefined : readUsageMeterListReserve(slice, accountCount, narrow);
}

/**
 * The height a settled list body has shown, kept while it stays open. Its optional lines (the pace alert, the
 * shared reason, the legend) come and go with every read, so the body keeps the tallest height it has drawn and
 * they come and go inside it. The floor starts over when the viewer changes the list's own shape (Show all, a
 * resize), so a deliberate collapse is never held open. Before the first settle the first-read reserve holds the room.
 */
export function useSettledBodyHeightFloor(settled: boolean, shapeKey: string): Readonly<{
  minHeight: number | undefined;
  onLayout: (event: LayoutChangeEvent) => void;
}> {
  const [floor, setFloor] = React.useState<Readonly<{ shapeKey: string; height: number }>>({ shapeKey, height: 0 });
  const onLayout = React.useCallback((event: LayoutChangeEvent) => {
    if (!settled) return;
    const height = Math.ceil(event.nativeEvent.layout.height);
    setFloor((current) => current.shapeKey !== shapeKey ? { shapeKey, height }
      : height > current.height ? { shapeKey, height } : current);
  }, [settled, shapeKey]);
  // A re-read puts accounts back to pending: the floor recorded while settled stays, only new layouts wait for a settle.
  return { minHeight: floor.shapeKey === shapeKey && floor.height > 0 ? floor.height : undefined, onLayout };
}

/** The one Show all · N / Show less control under a led list (Breakdowns, Session value). */
export function UsageShowAllRows(props: Readonly<{ total: number; complete?: boolean; expanded: boolean; onToggle: () => void; testID: string }>) {
  return (
    <View style={showAllStyles.action}>
      <RoundButton size="small" display="inverted" testID={props.testID}
        title={props.expanded ? t('usage.showLess') : `${t(props.complete === false ? 'usage.showAvailable' : 'usage.showAll')} · ${props.total}`} onPress={props.onToggle} />
    </View>
  );
}

const showAllStyles = StyleSheet.create(() => ({ action: { alignSelf: 'flex-start' } }));
