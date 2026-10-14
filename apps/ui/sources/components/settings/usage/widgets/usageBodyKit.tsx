import * as React from 'react';
import type { PluginUiThemeV1 } from '@happier-dev/plugin-sdk/ui';
import { View } from 'react-native';
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
export function UsageBodyReading(props: Readonly<{ testID: string }>) {
  const { theme } = useUnistyles();
  const reducedMotion = useReducedMotionPreference();
  const color = theme.colors.surface.pressedOverlay;
  return (
    <View testID={props.testID} style={readingStyles.body}>
      <HappierSkeletonBlock color={color} width="28%" height={28} radius={6} reducedMotion={reducedMotion} />
      <HappierSkeletonBlock color={color} width="100%" height={8} radius={4} reducedMotion={reducedMotion} />
      <HappierSkeletonBlock color={color} width="56%" height={12} radius={4} reducedMotion={reducedMotion} />
    </View>
  );
}

const readingStyles = StyleSheet.create(() => ({ body: { gap: 12, paddingVertical: 4 } }));

/** True while every read a body depends on is still outstanding (pending or not yet loaded). */
export function isUsageReadOutstanding(slice: UsageQueryResultSlice, sources: readonly string[]): boolean {
  const gaps = readUsageCoverageGaps(slice, sources);
  return gaps.length > 0 && gaps.every(gap => gap.status === 'pending' || gap.status === 'not_loaded');
}

/** "No usage in this period" only once the usage read answered; until then the body is loading. */
export function UsageBodyNoUsage(props: Readonly<{ slice: UsageQueryResultSlice; testID: string }>) {
  if (isUsageReadOutstanding(props.slice, ['accounting'])) return <UsageBodyReading testID={`${props.testID}.loading`} />;
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

export function describeUsagePagePendingSources(slices: readonly Pick<UsageQueryResultSlice, 'sources'>[]): string | null {
  // Only the page's shared reads; a widget's own read (a pool selection) is said by that widget.
  const names = [...new Set(slices.flatMap(slice => slice.sources
    .filter(source => source.status === 'pending' || source.status === 'not_loaded')
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
