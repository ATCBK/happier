import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { readHappierVisibleLayoutWidth } from '@happier-dev/plugin-ui/presentation/pageMetrics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useUnistyles } from 'react-native-unistyles';
import {
  HAPPIER_DATA_METRICS,
  StackedSeriesChart,
  type HappierSeries,
  type HappierSeriesBucket,
} from '@happier-dev/plugin-ui/presentation';

import { usePluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';
import { useUsageSeriesLens } from '@/components/settings/usage/usageSeriesPresentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';

import type { MachineVitalsTimeline } from './machineVitalsPresentation';
import { formatVitalsPointTime } from './vitalsFormat';

/** Room at a chart's right for its scale labels ("100%", "60 GB"), shared by every vitals chart. */
export const VITALS_SCALE_GUTTER_PX = 40;
const STALE_INK_OPACITY = 0.55;
const STALE_FADE_MS = 200;

export type VitalsChartFreshness = 'live' | 'stale' | 'offline';

/**
 * One vitals history through the one chart owner (`StackedSeriesChart`, plan 20 VIT-19): the range's
 * points on their real times, gaps as gaps, the scale labelled at the right and the range's two ends
 * under it. While live, each new sample slides the line one step with its endpoint held at the right
 * edge; stale or offline, the ink dims and the live point goes. The Usage lens reads any point.
 */
export const VitalsHistoryChart = React.memo(function VitalsHistoryChart(
  props: Readonly<{
    label: string;
    timeline: MachineVitalsTimeline;
    series: readonly HappierSeries[];
    variant: 'area' | 'line';
    domain: Readonly<{ min: number; max: number }>;
    scaleTicks: readonly Readonly<{ value: number; label: string }>[];
    axis: readonly [string, string];
    format: (value: number) => string;
    freshness: VitalsChartFreshness;
    /** The live slide belongs to the hour, whose newest point arrives every sample. */
    live: boolean;
    mirrored?: boolean;
    /** A widget's "Warn above" line: the part of the series above it takes the tone. */
    threshold?: Readonly<{ value: number; label: string; tone: 'warning' | 'error' }>;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const pluginTheme = usePluginUiTheme(theme);
  const reducedMotion = useReducedMotionPreference();
  const presented = useLayoutPresentationActive();
  const hostViewed = useHostActivelyViewed();
  const [width, setWidth] = React.useState(0);
  const onLayout = React.useCallback(
    (event: LayoutChangeEvent) => {
      // A retained, hidden panel measures zero; keep its chart until a real resize.
      const visibleWidth = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
      if (visibleWidth !== null) setWidth(visibleWidth);
    },
    [],
  );
  // The range's start is a point of its own, so a range that has only begun is drawn where it lies.
  const series = React.useMemo(
    () => withRangeStart(props.series, props.timeline.start),
    [props.series, props.timeline.start],
  );
  const lens = useUsageSeriesLens({
    series,
    format: props.format,
    accentColor: theme.colors.text.secondary,
    pointTitle: titleVitalsPoint,
    ...(props.testID ? { testID: `${props.testID}-lens` } : {}),
  });
  const points = props.timeline.points;
  const previous =
    points.length > 1 ? points[points.length - 2]!.t : props.timeline.end;
  const plotWidth = Math.max(0, width - VITALS_SCALE_GUTTER_PX);
  const stepPx =
    (plotWidth * Math.max(0, props.timeline.end - previous)) /
    Math.max(1, props.timeline.end - props.timeline.start);
  const keyed = props.series.some((entry) => entry.overlay === true);
  const fresh = props.freshness === 'live';
  const opacity = useSharedValue(fresh ? 1 : STALE_INK_OPACITY);
  React.useEffect(() => {
    const target = fresh ? 1 : STALE_INK_OPACITY;
    opacity.value = reducedMotion
      ? target
      : withTiming(target, { duration: STALE_FADE_MS });
  }, [fresh, opacity, reducedMotion]);
  const inkStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <View testID={props.testID} onLayout={onLayout}>
      {width > 0 ? (
        <Animated.View style={inkStyle}>
          <StackedSeriesChart
            theme={pluginTheme}
            label={props.label}
            series={series}
            variant={props.variant}
            size="tile"
            width={width}
            viewportHeight={HAPPIER_DATA_METRICS.plotHeightPx}
            plotInset={HAPPIER_DATA_METRICS.lineStrokePx}
            domain={props.domain}
            scaleGutter={VITALS_SCALE_GUTTER_PX}
            scaleTicks={props.scaleTicks}
            axisTicks={props.axis}
            // A history that carries the minute's maximum names its two lines; a single line needs no key.
            showLegend={keyed}
            showReadout={false}
            mirrored={props.mirrored}
            {...(props.threshold ? { threshold: props.threshold } : {})}
            valueFormatter={props.format}
            // A point's time is said only where it is read (the lens, an accessible name), never built for every point on every sample.
            coordinateFormatter={formatVitalsPointTime}
            reducedMotion={reducedMotion}
            {...(props.live
              ? {
                  liveMotion: {
                    sampleKey: props.timeline.end,
                    stepPx,
                    durationMs: Math.max(0, props.timeline.end - previous),
                    active: fresh && presented && hostViewed,
                  },
                }
              : {})}
            {...lens}
            {...(props.testID ? { testID: `${props.testID}-plot` } : {})}
          />
        </Animated.View>
      ) : (
        // Before the first measure the chart's box is already its final height, so nothing moves.
        <View
          style={{ height: HAPPIER_DATA_METRICS.plotHeightPx + AXIS_ROW_PX + (keyed ? KEY_ROW_PX : 0) }}
        />
      )}
    </View>
  );
});

/** History points carry no label; the lens titles one by its time, read only when it is shown. */
function titleVitalsPoint(bucket: HappierSeriesBucket): string {
  return typeof bucket.x === 'number' ? formatVitalsPointTime(bucket.x) : bucket.label;
}

/** The axis row under a tile chart: one caption line and its gap. */
const AXIS_ROW_PX = 20;
/** The key row under the axis when the chart names its two lines: one caption line and its gap. */
const KEY_ROW_PX = HAPPIER_DATA_METRICS.blockGapPx + 16;

function withRangeStart(
  series: readonly HappierSeries[],
  start: number,
): readonly HappierSeries[] {
  return series.map((entry) => {
    const first = entry.points[0];
    if (first && typeof first.x === 'number' && first.x <= start) return entry;
    return {
      ...entry,
      points: [
        { id: 'range-start', x: start, y: null },
        ...entry.points,
      ],
    };
  });
}
