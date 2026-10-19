import * as React from 'react';
import { View } from 'react-native';
import { HappierDataMetric, HappierDataRows } from '@happier-dev/plugin-ui/presentation';
import type { UsageAnalyticsCoverage } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { t } from '@/text';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { UsageModelPricesLine } from './UsageModelPrices';
import { UsageBodyInsufficient, UsageBodyNoUsage, UsageCoverageLine, readUsageCoverageGaps,
  usageCoverageDescription, usagePeriodPhrase, usageSourceTitle, useUsagePluginTheme, type UsageBodyProps } from './usageBodyKit';

const statusKeys = {
  available: 'usage.board.sources.coverageAvailable', partial: 'usage.board.page.factIncomplete',
  unknown: 'usage.board.sources.coverageUnknown', unsupported: 'usage.board.sources.unsupported',
  pending: 'usage.board.page.loading', error: 'usage.board.sources.failed',
} as const;
const captureKeys = {
  measured: 'usage.board.page.sourceKindMeasured', from_logs: 'usage.board.page.sourceKindFromLogs',
  not_added: 'usage.board.page.sourceKindNotAdded',
} as const;

/** Witnessed accounting coverage, never a guessed Agent support table or a second discovery read. */
export function UsageSourceCoverageWidget(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  if (!props.slice.accounting) return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  const sources = props.slice.accounting.coverage?.sources ?? [];
  const gaps = readUsageCoverageGaps(props.slice, ['accounting']);
  const description = usageCoverageDescription(props.slice, ['accounting']);
  const failed = gaps.some(gap => gap.status === 'error');
  return <View testID={`${props.testID}.facts`}>
    {sources.length ? <HappierDataRows theme={theme} testID={`${props.testID}.rows`} label={t('usage.widgets.usage_source_coverage')}
      columns={[{ label: t('usage.widgets.usage_sources') }, { label: t('usage.widgets.usage_source_coverage') }]}
      rows={sources.map(source => [usageSourceTitle(source.source), sourceCoverageLabel(source)])} />
      : <UsageBodyInsufficient testID={`${props.testID}.unknown`} replacesContent={false} title={t('usage.board.sources.coverageUnknown')} />}
    {description ? <SurfaceFreshnessLine testID={`${props.testID}.detail`} reason={description} tone={failed ? 'warning' : 'neutral'}
      {...(failed ? { action: { label: t('common.retry'), onPress: props.model.refresh } } : {})} /> : null}
  </View>;
}

function sourceCoverageLabel(source: UsageAnalyticsCoverage['sources'][number]): string {
  return [source.captureKind ? t(captureKeys[source.captureKind]) : null, t(statusKeys[source.status]),
    source.status === 'available' && source.historyComplete !== true
      ? t(source.historyComplete === false ? 'usage.board.page.factIncomplete' : 'usage.board.sources.coverageUnknown') : null].filter(Boolean).join(' · ');
}

/** The same unpriced population as Cost facts; unknown dollars never become a zero-dollar metric. */
export function UsageUnpricedWidget(props: UsageBodyProps) {
  const theme = useUsagePluginTheme();
  useWidgetFrameBodyCaption(usagePeriodPhrase(props.query));
  if (!props.slice.accounting) return <UsageBodyNoUsage slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />;
  const facts = props.slice.costFactTotals?.filter(fact => fact.kind === 'unpriced');
  const total = facts?.reduce((sum, fact) => sum + fact.tokens.total, 0);
  return <View testID={`${props.testID}.facts`}>
    <HappierDataMetric theme={theme} testID={`${props.testID}.tokens`} size="stat" showLabel
      label={t('usage.board.sources.unpricedPurpose')} value={total ?? '—'} unit={t('usage.board.page.tokensUnit')}
      valueFormatter={formatTokenCount} caption={total === undefined ? t('usage.board.page.notMeasuredYet')
        : [t('usage.board.page.unpricedCaption'), facts?.some(fact => !fact.complete) ? t('usage.board.page.factIncomplete') : null].filter(Boolean).join(' · ')} />
    <UsageModelPricesLine slice={props.slice} serverId={props.serverId} testID={`${props.testID}.prices`} />
    <UsageCoverageLine slice={props.slice} sources={['accounting']} onRetry={props.model.refresh} testID={`${props.testID}.coverage`} />
  </View>;
}
