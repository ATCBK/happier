import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { projectUsagePageCost } from '@happier-dev/protocol/usage/usageCostFacts';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  CompositionStrip,
  HappierDataMetric,
} from '@happier-dev/plugin-ui/presentation';
import { ChartTooltip } from '@/components/ui/charts';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { useDeviceType } from '@/utils/platform/responsive';
import {
  formatTokenCount,
  formatTokenCountLong,
  formatUsageCost,
} from '@/utils/format/usageNumbers';
import { t } from '@/text';
import { usageSeriesColor } from '../usageAccent';
import { usageCostKindPhrase } from '../usageCostPresentation';
import {
  usageCompositionSegments,
  usageCompositionShareLabel,
} from '../usageCompositionPresentation';
import {
  UsageBodyInsufficient,
  UsageCoverageLine,
  usagePeriodPhrase,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
  UsageBodyNoUsage,
} from './usageBodyKit';

/** Below this width the mix is the dot waffle (lab `kitcharts`: "waffle on tile and phone"). */
const WAFFLE_BELOW_PX = 360;

/**
 * "Efficiency": cache hit rate and cost per million tokens beside the token mix they come from.
 * Ratios need their basis; without one the fact is absent rather than a misleading zero.
 */
export function UsageEfficiencyWidget(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const presentation = useWidgetPresentation();
  const phone = useDeviceType() === 'phone';
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  // The same exact legend either way; only the picture changes with the room there is.
  const waffle =
    phone ||
    presentation?.footprint.width === 'compact' ||
    (presentation?.geometry?.width ?? Number.POSITIVE_INFINITY) <
      WAFFLE_BELOW_PX;
  if (!view)
    return <UsageBodyNoUsage slice={props.slice} testID={props.testID} />;
  const { composition } = view;
  const totalTokens = props.slice.accounting?.totals.tokens.total ?? 0;
  const efficiency = { ...view.efficiency,
    costPerMtokUsd: totalTokens > 0 && view.pageCost.amountUsd !== null
      ? view.pageCost.amountUsd / totalTokens * 1e6 : null,
    currency: view.pageCost.selection?.currency ?? 'USD' };
  const previous = props.slice.comparison?.accounting;
  const previousCost = previous
    ? projectUsagePageCost(previous, props.query.costBasis, view.pageCost.selection).amountUsd : null;
  const previousPerMtok =
    previous && previous.totals.tokens.total > 0 && previousCost !== null
      ? (previousCost /
          previous.totals.tokens.total) *
        1e6
      : null;
  const perMtokDelta =
    efficiency.costPerMtokUsd !== null &&
    previousPerMtok !== null &&
    previousPerMtok > 0
      ? (efficiency.costPerMtokUsd - previousPerMtok) / previousPerMtok
      : null;
  const hasRatios =
    efficiency.cacheHitRatePct !== null || efficiency.costPerMtokUsd !== null;
  const segments = usageCompositionSegments(composition, (index) =>
    usageSeriesColor(theme, index),
  );
  if (!hasRatios && segments.length === 0)
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.noBasis`}
        title={t('usage.board.page.efficiencyNoBasisTitle')}
        reason={t('usage.board.page.efficiencyNoBasisReason')}
      />
    );
  return (
    <View style={styles.body} testID={`${props.testID}.efficiency`}>
      {hasRatios ? (
        <View style={styles.grid}>
          {efficiency.cacheHitRatePct !== null ? (
            <View style={styles.cell}>
              <HappierDataMetric
                testID={`${props.testID}.cacheHit`}
                theme={chartTheme}
                size="stat"
                showLabel
                label={t('usage.board.page.cacheHit')}
                value={efficiency.cacheHitRatePct / 100}
                valueFormatter={(value) => `${Math.round(value * 100)}%`}
                caption={
                  view.cacheSavings?.cacheSavingsUsd != null
                    ? t('usage.board.page.cacheListPriceDifference', {
                        amount: formatUsageCost(
                          view.cacheSavings.cacheSavingsUsd,
                          'USD',
                        ),
                      })
                    : t('usage.board.page.cacheReadTokens', {
                        tokens: formatTokenCount(efficiency.cachedReadTokens),
                      })
                }
              />
            </View>
          ) : null}
          {efficiency.costPerMtokUsd !== null ? (
            <View style={styles.cell}>
              <HappierDataMetric
                testID={`${props.testID}.perMtok`}
                theme={chartTheme}
                size="stat"
                showLabel
                label={t('usage.board.page.perMillionTokens')}
                value={efficiency.costPerMtokUsd}
                caption={view.pageCost.selection ? usageCostKindPhrase(view.pageCost.selection.kind) : undefined}
                valueFormatter={(value) =>
                  formatUsageCost(value, efficiency.currency)
                }
                {...(perMtokDelta !== null
                  ? {
                      comparison: {
                        value: `${perMtokDelta >= 0 ? '▲' : '▼'} ${Math.round(Math.abs(perMtokDelta) * 100)}%`,
                        label: t('usage.board.page.vsBefore'),
                        meaning:
                          perMtokDelta <= 0
                            ? ('good' as const)
                            : ('bad' as const),
                      },
                    }
                  : {})}
              />
            </View>
          ) : null}
        </View>
      ) : null}
      {segments.length > 0 ? (
        <CompositionStrip
          theme={chartTheme}
          label={t('usage.context.tokenMixTitle')}
          total={composition.total}
          segments={segments}
          basis={t('usage.tokens')}
          size={waffle ? 'tile' : 'full'}
          variant={waffle ? 'waffle' : 'strip'}
          minimumVisibleFraction={0.005}
          minimumFillWidth={2}
          segmentGap={2}
          valueFormatter={formatTokenCount}
          shareFormatter={usageCompositionShareLabel}
          unknownLabel="—"
          testID={`${props.testID}.mix`}
          renderBarSegment={(segment, visual, share) => (
            <ChartTooltip
              triggerTestID="usage-efficiency-mix-trigger"
              title={segment.label}
              subtitle={
                share === null ? undefined : usageCompositionShareLabel(share)
              }
              value={
                segment.value === null
                  ? '—'
                  : formatTokenCountLong(segment.value)
              }
              accentColor={segment.color ?? chartTheme.colors.accent}
            >
              {visual}
            </ChartTooltip>
          )}
        />
      ) : null}
      <UsageCoverageLine
        slice={props.slice}
        sources={['accounting', 'comparison']}
        onRetry={props.model.refresh}
        testID={`${props.testID}.coverage`}
      />
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  body: { gap: 18 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 24, rowGap: 16 },
  cell: { flexGrow: 1, flexBasis: 140, minWidth: 0 },
}));
