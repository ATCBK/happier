import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { HappierDataMetric } from '@happier-dev/plugin-ui/presentation';
import { projectUsagePageCost } from '@happier-dev/protocol/usage/usageCostFacts';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { formatTokenCount, formatUsageCost } from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import {
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
  UsageBodyNoUsage,
} from './usageBodyKit';
import { usageCostKindPhrase } from '../usageCostPresentation';
import { formatUsageDurationCompact } from './usageHowYouWorkPresentation';

const HOUR_MS = 60 * 60 * 1000;

/**
 * "Your month": the one multi-number widget. The hero is the shown metric with its exact preceding
 * range; below it only facts this query actually produced (paid, merged work, agent time).
 */
export function UsagePeriodSummaryWidget(props: UsageBodyProps) {
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  if (!view)
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} />;
  const cost = props.query.metric === 'cost';
  const selectedCost = view.pageCost;
  const currency = selectedCost.selection?.currency ?? view.costPresentation.currency;
  const current = cost ? selectedCost.amountUsd : view.hero.totalTokens;
  const previousAccounting = props.slice.comparison?.accounting;
  const previous = previousAccounting
    ? cost
      ? projectUsagePageCost(previousAccounting, props.query.costBasis, selectedCost.selection).amountUsd
      : previousAccounting.totals.tokens.total
    : null;
  const delta =
    current !== null && previous !== null && previous > 0 ? (current - previous) / previous : null;
  const apiEquivalent = props.slice.costFactTotals?.find(fact => fact.kind === 'api_equivalent' && fact.currency === currency);
  const invoice = props.slice.costFactTotals?.find(fact => fact.kind === 'invoice' && fact.currency === currency);
  const merged =
    props.slice.work?.outcomes.filter(
      (outcome) => outcome.pullRequest.state === 'merged',
    ) ?? null;
  const measuredIntervals = props.slice.howYouWork?.intervals;
  const intervals = measuredIntervals?.coverage === 'complete_for_supplied_facts' ? measuredIntervals : null;
  const subline = [
    delta !== null ? t('usage.board.page.vsPrevious') : null,
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
        caption={
          selectedCost.selection
            ? usageCostKindPhrase(selectedCost.selection.kind)
            : t('common.unavailable')
        }
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
        reserveCaption
        caption={
          merged && merged.length > 0 ? t('usage.board.page.linkedByEvidence') : undefined
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
        reserveCaption
        caption={intervals ? t('usage.board.page.elapsedTime', {
          time: formatUsageDurationCompact(intervals.elapsedBusyMs),
        }) : undefined}
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
        value={view.insights.activeDays}
        caption={t('usage.board.page.longestStreak', {
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
          caption={current === null ? t('common.unavailable')
            : cost && selectedCost.selection ? usageCostKindPhrase(selectedCost.selection.kind) : undefined}
          unit={cost ? undefined : t('usage.board.page.tokensUnit')}
          valueFormatter={
            cost
              ? (value) => formatUsageCost(value, currency)
              : formatTokenCount
          }
          {...(delta !== null
            ? {
                comparison: {
                  value: `${delta >= 0 ? '▲' : '▼'} ${Math.round(Math.abs(delta) * 100)}%`,
                  label: subline,
                  meaning: 'neutral' as const,
                },
              }
            : {})}
        />
        {delta === null ? <Text style={styles.subline}>{subline}</Text> : null}
      </View>
      <View style={styles.stats}>
        {stats.map((stat) => (
          <View key={stat.key} style={styles.stat}>
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
  subline: {  ...Typography.variant('body'),  color: theme.colors.text.secondary },
  body: { gap: theme.space.s20 },
  hero: { gap: theme.space.s4 },
  stats: { flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space.s24, rowGap: theme.space.s16 },
  stat: { flexGrow: 1, flexBasis: 120, minWidth: 0 },
}));
