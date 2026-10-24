import { useState } from 'react';
import { View } from 'react-native';
import type { HappierUiTheme } from '../../environment/types.js';
import type { HappierLayoutChangeEvent } from '../portableTypes.js';
import { readHappierVisibleLayoutWidth } from '../layout/pageMetrics.js';
import { HappierText } from '../text/Text.js';
import { StackedSeriesChart } from './StackedSeriesChart.js';
import { HAPPIER_DATA_METRICS, useHappierDataTextStyles } from './dataText.js';

/** One observed logical core. `busyPct` is 0–100; `null` means not reported. */
export type CoreLoadBar = Readonly<{ index: number; busyPct: number | null; cluster?: 'p' | 'e' }>;
export type CoreLoadBarsProps = Readonly<{
  /** Public presentation theme, available from `usePluginTheme()`. */
  theme: HappierUiTheme;
  /** Accessible name of the complete group. */
  label: string;
  /** Observations are displayed by cluster (performance, efficiency, other), then index. */
  cores: readonly CoreLoadBar[];
  /** Available pixels; omission uses the measured layout and wraps cores into rows. */
  width?: number;
  /** Localized exact value or unavailable state, including the core's identity. */
  coreLabel: (core: CoreLoadBar) => string;
  /** Localized descriptions shown only for clusters present in `cores`. */
  legend?: Readonly<{ p?: string; e?: string }>;
  testID?: string;
}>;

export function CoreLoadBars(props: CoreLoadBarsProps) {
  const [measuredWidth, setWidth] = useState(0);
  const text = useHappierDataTextStyles(props.theme);
  const width = props.width ?? measuredWidth;
  const rank = (core: CoreLoadBar) => core.cluster === 'p' ? 0 : core.cluster === 'e' ? 1 : 2;
  const cores = [...props.cores].sort((a, b) => rank(a) - rank(b) || a.index - b.index);
  const coreById = new Map(cores.map((core) => [String(core.index), core]));
  const { coreWidthPx, coreGapPx, coreHeightPx } = HAPPIER_DATA_METRICS;
  const perRow = width > 0 ? Math.max(1, Math.floor((width + coreGapPx) / (coreWidthPx + coreGapPx))) : Math.max(1, cores.length);
  const rows = Array.from({ length: Math.ceil(cores.length / perRow) }, (_, index) => cores.slice(index * perRow, (index + 1) * perRow));
  return <View testID={props.testID} accessibilityLabel={props.label} style={{ width: props.width, gap: coreGapPx }}
    onLayout={(event: HappierLayoutChangeEvent) => {
      const visibleWidth = readHappierVisibleLayoutWidth(event.nativeEvent.layout.width);
      if (visibleWidth !== null) setWidth(visibleWidth);
    }}>
    {rows.map((row, rowIndex) => <StackedSeriesChart key={rowIndex} theme={props.theme} label={props.label}
      series={[{ id: 'cores', label: props.label, points: row.map((core) => ({ id: String(core.index), x: core.index,
        y: core.busyPct, color: core.cluster === 'e' ? props.theme.colors.mutedText : props.theme.colors.secondaryText, opacity: 1 })) }]}
      variant="bar" size="tile" width={width} viewportHeight={coreHeightPx} minimumMaximum={100}
      barSlotWidth={Math.min(coreWidthPx, width || coreWidthPx)} barGap={coreGapPx} barTrackColor={props.theme.colors.divider}
      showGrid={false} showAxis={false} showLegend={false} showReadout={false}
      testID={props.testID ? `${props.testID}-row-${rowIndex}` : undefined}
      renderBucket={(bucket, visual) => {
        const core = coreById.get(bucket.id)!;
        return <View testID={props.testID ? `${props.testID}-core-${core.index}` : undefined} accessible
          accessibilityRole="image" accessibilityLabel={props.coreLabel(core)}>{visual}</View>;
      }} />)}
    {props.legend ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: HAPPIER_DATA_METRICS.columnGapPx, marginTop: HAPPIER_DATA_METRICS.axisGapPx }}>
      {(['p', 'e'] as const).filter((cluster) => cores.some((core) => core.cluster === cluster) && props.legend?.[cluster])
        .map((cluster) => <View key={cluster} style={{ flexDirection: 'row', alignItems: 'center', gap: HAPPIER_DATA_METRICS.axisGapPx }}>
          <View aria-hidden importantForAccessibility="no" style={{ width: HAPPIER_DATA_METRICS.proportionHeightPx, height: HAPPIER_DATA_METRICS.proportionHeightPx,
            backgroundColor: cluster === 'e' ? props.theme.colors.mutedText : props.theme.colors.secondaryText }} />
          <HappierText style={text.caption}>{props.legend?.[cluster]}</HappierText>
        </View>)}
    </View> : null}
  </View>;
}
