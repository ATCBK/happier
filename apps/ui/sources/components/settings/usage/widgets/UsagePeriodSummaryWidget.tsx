import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsageComparisonCost,
  useUsagePluginTheme,
  type UsageBodyProps,
  UsageBodyNoUsage,
} from './usageBodyKit';
import { usageCostKindPhrase } from '../usageCostPresentation';
import { formatUsageDurationCompact } from './usageHowYouWorkPresentation';
import { usageComparison } from '../usageComparisonPresentation';

const HOUR_MS = 60 * 60 * 1000;

/**
 * "Your month": the one multi-number widget. The hero is the shown metric with its exact preceding
 * range; below it only facts this query actually produced (paid, merged work, agent time).
 */
export function UsagePeriodSummaryWidget(props: UsageBodyProps) {
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const previousCost = useUsageComparisonCost(props.slice, props.query.costBasis,
    props.query.metric === 'cost' ? view?.pageCost.selection : null);
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  if (!view)
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} readingShape={{ kind: 'summary' }} onRetry={props.model.refresh} />;
  const cost = props.query.metric === 'cost';
  const selectedCost = view.pageCost;
  const currency = selectedCost.selection?.currency ?? view.costPresentation.currency;
  // `amountUsd` is authoritative: a candidate basis with an unavailable amount means some usage has
  // neither a reported cost nor a model price, never "estimated where not reported" under a dash.
  const costCaption =
    selectedCost.amountUsd !== null && selectedCost.selection
      ? usageCostKindPhrase(selectedCost.selection.kind)
      : selectedCost.selection
        ? t('usage.board.page.costUnpricedCaption')
        : t('common.unavailable');
  const current = cost ? selectedCost.amountUsd : view.hero.totalTokens;
  const previousAccounting = props.slice.comparison?.accounting;
  const previous = previousAccounting
    ? cost
      ? previousCost
      : previousAccounting.totals.tokens.total
    : null;
  const comparison = usageComparison(current, previous);
  const apiEquivalent = props.slice.costFactTotals?.find(fact => fact.kind === 'api_equivalent' && fact.currency === currency);
  const invoice = props.slice.costFactTotals?.find(fact => fact.kind === 'invoice' && fact.currency === currency);
  const merged =
    props.slice.work?.outcomes.filter(
      (outcome) => outcome.pullRequest.state === 'merged',
    ) ?? null;
  const measuredIntervals = props.slice.howYouWork?.intervals;
  const intervals = measuredIntervals?.coverage === 'complete_for_supplied_facts' ? measuredIntervals : null;
  const subline = [
    comparison !== null ? t('usage.board.page.vsPrevious') : null,
    t('usage.board.page.sessionsCount', {
      count: view.hero.sessions.toLocaleString(),
    }),
    !cost && apiEquivalent?.amountUsd != null
      ? t('usage.board.page.atApiPrices', {
          amount: formatUsageCost(apiEquivalent.amountUsd, currency),
        })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const stats: React.ReactElement[] = [];
  if (!cost && invoice?.amountUsd != null)
    stats.push(
      <HappierDataMetric
        key="paid"
        theme={chartTheme}
        size="stat"
        showLabel
        label={t('usage.board.page.youPaid')}
        value={invoice.amountUsd}
        valueFormatter={(value) => formatUsageCost(value, currency)}
        caption={usageCostKindPhrase('invoice')}
      />,
    );
  else
    stats.push(
      <HappierDataMetric
        key="cost"
        theme={chartTheme}
        size="stat"
        showLabel
        label={t('usage.cost')}
        // An unknown is a quiet dash with its reason beneath, never a headline word (lab d2top "You paid").
        value={selectedCost.amountUsd ?? UNKNOWN_VALUE}
        valueFormatter={(value) => formatUsageCost(value, currency)}
        caption={costCaption}
      />,
    );
  if (props.query.includeWorkEvidence)
    stats.push(
      <HappierDataMetric
        key="merged"
        theme={chartTheme}
        size="stat"
        showLabel
        label={t('usage.board.page.mergedPrs')}
        value={merged?.length ?? UNKNOWN_VALUE}
        // Every figure, a zero or a dash included, says why it reads as it does in the same caption slot.
        caption={
          !merged
            ? t('usage.board.page.notMeasuredYet')
            : merged.length > 0
              ? t('usage.board.page.linkedByEvidence')
              : t('usage.board.page.noneLinkedByEvidence')
        }
      />,
    );
  // The query chooses the statistic; asynchronous arrivals only replace its
  // value. An unanswered duration never temporarily becomes Active days.
  if (props.query.includeSessionEvidence)
    stats.push(
      <HappierDataMetric
        key="agent"
        theme={chartTheme}
        size="stat"
        showLabel
        label={t('usage.board.page.agentTime')}
        value={intervals ? intervals.agentTimeMs / HOUR_MS : UNKNOWN_VALUE}
        valueFormatter={intervals ? () => formatUsageDurationCompact(intervals.agentTimeMs) : undefined}
        caption={intervals ? t('usage.board.page.elapsedTime', {
          time: formatUsageDurationCompact(intervals.elapsedBusyMs),
        }) : t('usage.board.page.notMeasuredYet')}
      />,
    );
  else
    stats.push(
      <HappierDataMetric
        key="active"
        theme={chartTheme}
        size="stat"
        showLabel
        label={t('usage.board.page.activeDays')}
        value={view.insights.activeDays ?? UNKNOWN_VALUE}
        caption={view.hero.longestStreakDays === null ? undefined : t('usage.board.page.longestStreak', {
          count: view.hero.longestStreakDays,
        })}
      />,
    );
  return (
    <View style={styles.body} testID={`${props.testID}.summary`}>
      <View style={styles.hero}>
        <HappierDataMetric
          testID={`${props.testID}.hero`}
          theme={chartTheme}
          size="hero"
          label={cost ? t('usage.cost') : t('usage.tokens')}
          value={current ?? UNKNOWN_VALUE}
          caption={cost ? costCaption : current === null ? t('common.unavailable') : undefined}
          unit={cost ? undefined : t('usage.board.page.tokensUnit')}
          valueFormatter={
            cost
              ? (value) => formatUsageCost(value, currency)
              : formatTokenCount
          }
          {...(comparison !== null
            ? {
                comparison: {
                  value: comparison.value,
                  label: subline,
                  meaning: 'neutral' as const,
                },
              }
            : {})}
        />
        {comparison === null ? <Text style={styles.subline}>{subline}</Text> : null}
      </View>
      <View style={styles.stats}>
        {stats.map((stat, index) => (
          <View key={stat.key} style={index === 0 ? styles.statLead : styles.stat}>
            {stat}
          </View>
        ))}
      </View>
      <UsageCoverageLine
        slice={props.slice}
        sources={['accounting', 'comparison']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

const UNKNOWN_VALUE = '—';

const styles = StyleSheet.create((theme) => ({
  // The line under the figure sits where the comparison's label sits once it lands (same role, colour and
  // gap as HappierDataMetric's), so the comparison's arrival replaces this line without moving what is below.
  subline: { ...Typography.variant('micro'), color: theme.colors.text.tertiary },
  body: { gap: theme.space.s20 },
  hero: { gap: 2 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s24, rowGap: theme.space.s16 },
  stat: { flexGrow: 1, flexBasis: 100, minWidth: 0 },
  // The money cell carries the longest caption ("reported where known, otherwise estimated"): it takes
  // the larger share so that line wraps in two, never cut, and a phone gives it its own row.
  statLead: { flexGrow: 2, flexBasis: 168, minWidth: 0 },
}));
