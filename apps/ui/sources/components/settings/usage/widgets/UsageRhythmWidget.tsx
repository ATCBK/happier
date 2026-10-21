import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import {
  DotGrid,
  Heatmap,
  StackedSeriesChart,
} from '@happier-dev/plugin-ui/presentation';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { getPreferredLanguage, t } from '@/text';
import { usageSignatureAccent } from '../usageAccent';
import { resolveUsageShownCalendarRange } from '@/sync/domains/usage/usageCalendarPresentation';
import {
  usageDotGridPresentation,
  usageGridFrame,
  usageGridTooltip,
  usageHeatmapPresentation,
} from '../usageGridPresentation';
import {
  createUsageHourRhythmSeries,
  usageSeriesTooltip,
} from '../usageSeriesPresentation';
import {
  UsageBodyInsufficient,
  UsageBodyReading,
  UsageCoverageLine,
  isUsageReadOutstanding,
  useUsageAnalyticsView,
  useUsagePluginTheme,
  type UsageBodyProps,
} from './usageBodyKit';
import { UsageSkyStyleBody, UsageWeekTideStyleBody, UsageDaylightStyleBody } from './UsageChartStyleBodies';

/**
 * Below this body width the 7×24 matrix has no room to be read (a phone); the 24-hour rhythm says the same.
 * A half-width card keeps the matrix: its weekday axis is the point of the card (lab `d2views-OV`).
 */
const MATRIX_MIN_WIDTH_PX = 360;
/** Calendar and weekday×hour sit side by side only when each keeps a comfortable matrix width. */
const SIDE_BY_SIDE_MIN_WIDTH_PX = 880;

/**
 * What the settled body measures at the widths the page is designed for, so the reading state holds
 * that room: side by side (calendar beside weekday × hour), a half-width card (calendar over the matrix,
 * measured at ~430 px) and a phone (calendar over the 24-hour rhythm). Other widths hold nothing rather
 * than a guess.
 */
const SETTLED_SIDE_BY_SIDE_BODY_PX = 180;
const SETTLED_HALF_WIDTH_BODY_PX = 272;
const HALF_WIDTH_MAX_PX = 520;
const SETTLED_PHONE_BODY_PX = 223;
function settledBodyPx(width: number | undefined): number | undefined {
  if (width === undefined) return undefined;
  if (width >= SIDE_BY_SIDE_MIN_WIDTH_PX) return SETTLED_SIDE_BY_SIDE_BODY_PX;
  if (width < MATRIX_MIN_WIDTH_PX) return SETTLED_PHONE_BODY_PX;
  return width < HALF_WIDTH_MAX_PX ? SETTLED_HALF_WIDTH_BODY_PX : undefined;
}

/** One body per widget: its Style own-input picks the encoding of the same question. */
export function UsageRhythmWidget(props: UsageBodyProps) {
  const style = props.presentation?.style;
  if (style === 'sky') return <UsageSkyStyleBody {...props} />;
  if (style === 'weekTide') return <UsageWeekTideStyleBody {...props} />;
  if (style === 'daylight') return <UsageDaylightStyleBody {...props} />;
  return <UsageRhythmWidgetOriginal {...props} />;
}

/**
 * "When you work": the active-days calendar beside the weekday × hour rhythm, both read from the same
 * admitted activity facts in the query's own calendar (fixed offset, Monday weeks).
 */
function UsageRhythmWidgetOriginal(props: UsageBodyProps) {
  const { theme } = useUnistyles();
  const chartTheme = useUsagePluginTheme();
  const view = useUsageAnalyticsView(props.slice, props.query);
  const width = useWidgetPresentation()?.geometry?.width;
  const accent = usageSignatureAccent(theme);
  const activity = view?.activity;
  const language = getPreferredLanguage();
  const calendar = React.useMemo(() => {
    const range = resolveUsageShownCalendarRange(props.query, props.slice.accounting?.coverage, props.slice.accounting);
    return activity && range ? usageHeatmapPresentation({ calendarDays: activity.calendarDays, mode: 'daily', range,
      coverage: props.slice.accounting?.coverage, accentColor: accent, emptyColor: theme.colors.surface.inset }) : null;
  }, [activity, props.query, props.slice.accounting, accent, theme.colors.surface.inset, language]);
  const hasCalendar = (activity?.calendarDays.length ?? 0) > 0;
  const hasRhythm =
    (view?.punchCard.total ?? 0) > 0 || (view?.hourRhythm.total ?? 0) > 0;
  const streak = view?.hero.longestStreakDays ?? 0;
  useWidgetFrameBodyCaption(
    view && streak > 0
      ? t('usage.board.howYouWork.longestStreak', { count: streak })
      : null,
  );
  if (!view || !activity || (!hasCalendar && !hasRhythm)) {
    if (isUsageReadOutstanding(props.slice, ['accounting']))
      return (
        <View style={{ minHeight: settledBodyPx(width) }}>
          <UsageBodyReading testID={`${props.testID}.loading`} />
        </View>
      );
    return (
      <UsageBodyInsufficient
        testID={`${props.testID}.empty`}
        title={t('usage.board.howYouWork.rhythmEmptyTitle')}
        reason={t('usage.board.howYouWork.rhythmEmptyReason')}
      />
    );
  }
  const matrix = width === undefined || width >= MATRIX_MIN_WIDTH_PX;
  const sideBySide = width !== undefined && width >= SIDE_BY_SIDE_MIN_WIDTH_PX;
  return (
    <View style={styles.body} testID={`${props.testID}.rhythm`}>
      <View style={[styles.blocks, sideBySide ? styles.row : null]}>
        {hasCalendar && calendar ? (
          <View style={[styles.block, sideBySide ? styles.half : null]}>
            <Text style={styles.label}>
              {t('usage.board.howYouWork.activeDays')}
            </Text>
            <Heatmap
              testID={`${props.testID}.calendar`}
              theme={chartTheme}
              showReadout={false}
              {...calendar}
              renderCell={usageGridTooltip(
                accent,
                'usage-heatmap-cell-trigger',
              )}
              renderFrame={
                calendar.layout === 'strip' ? undefined : usageGridFrame
              }
            />
          </View>
        ) : null}
        {hasRhythm ? (
          <View style={[styles.block, sideBySide ? styles.half : null]}>
            <Text style={styles.label}>
              {matrix
                ? t('usage.board.howYouWork.weekdayHour')
                : t('usage.board.howYouWork.byHour')}
            </Text>
            {matrix ? (
              <DotGrid
                testID={`${props.testID}.punchcard`}
                theme={chartTheme}
                showReadout={false}
                {...usageDotGridPresentation(
                  view.punchCard,
                  accent,
                  theme.colors.border.default,
                )}
                renderCell={usageGridTooltip(
                  accent,
                  'usage-punchcard-cell-trigger',
                )}
              />
            ) : (
              <StackedSeriesChart
                testID={`${props.testID}.hours`}
                theme={chartTheme}
                label={t('usage.workRhythm')}
                series={createUsageHourRhythmSeries(
                  view.hourRhythm,
                  accent,
                  theme.colors.border.default,
                )}
                variant="bar"
                size="tile"
                viewportHeight={52}
                barGap={2}
                barMinHeight={2}
                axisTicks={[
                  { label: '12A', bucket: 0 },
                  { label: '6A', bucket: 6 },
                  { label: '12P', bucket: 12 },
                  { label: '6P', bucket: 18 },
                ]}
                showGrid={false}
                showAnnotations
                showReadout={false}
                renderBucket={usageSeriesTooltip(
                  accent,
                  'usage-rhythm-hour-trigger',
                )}
              />
            )}
          </View>
        ) : null}
      </View>
      <UsageCoverageLine
        testID={`${props.testID}.coverage`}
        slice={props.slice}
        sources={['accounting']}
        onRetry={props.model.refresh}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.space.s12, minWidth: 0 },
  blocks: { gap: theme.space.s20 },
  row: { flexDirection: 'row', alignItems: 'flex-start' },
  block: { gap: theme.space.s8, minWidth: 0 },
  half: { flex: 1 },
  label: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.text.secondary,
  },
}));
