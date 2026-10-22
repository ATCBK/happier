import type { ReactNode } from 'react';
import { View } from 'react-native';
import { Heatmap, type HeatmapProps } from '../../data/Heatmap.js';
import { DotGrid, type DotGridProps } from '../../data/DotGrid.js';
import { StackedSeriesChart, type StackedSeriesChartProps } from '../../data/StackedSeriesChart.js';
import { useUsageChartWidth } from './chartKit.js';

/** The original form's matrix and two-column breakpoints, also used by its host reading state. */
export const USAGE_RHYTHM_MATRIX_MIN_WIDTH_PX = 360;
export const USAGE_RHYTHM_SIDE_BY_SIDE_MIN_WIDTH_PX = 880;

export type UsageRhythmChartProps = Readonly<{
  theme: HeatmapProps['theme'];
  width?: number;
  testID: string;
  spacing: Readonly<{ body: number; blocks: number; block: number }>;
  headings: Readonly<{ calendar: ReactNode; weekdayHour: ReactNode; byHour: ReactNode }>;
  calendar?: Omit<HeatmapProps, 'theme' | 'testID'>;
  punch?: Omit<DotGridProps, 'theme' | 'testID'>;
  hours?: Omit<StackedSeriesChartProps, 'theme' | 'testID'>;
  footer?: ReactNode;
}>;

/** The original calendar and weekday/hour form, shared by private and masked public hosts. */
export function UsageRhythmChart(props: UsageRhythmChartProps) {
  const [width, onLayout] = useUsageChartWidth(props.width);
  const matrix = width === null || width >= USAGE_RHYTHM_MATRIX_MIN_WIDTH_PX;
  const sideBySide = width !== null && width >= USAGE_RHYTHM_SIDE_BY_SIDE_MIN_WIDTH_PX;
  const blockStyle = [{ gap: props.spacing.block, minWidth: 0 }, sideBySide ? { flex: 1 } : null];
  return <View style={{ gap: props.spacing.body, minWidth: 0 }} testID={`${props.testID}.rhythm`}
    {...(props.width === undefined ? { onLayout } : {})}>
    <View style={[{ gap: props.spacing.blocks }, sideBySide ? { flexDirection: 'row', alignItems: 'flex-start' } : null]}>
      {props.calendar ? <View style={blockStyle}>
        {props.headings.calendar}
        <Heatmap showReadout={false} {...props.calendar} testID={`${props.testID}.calendar`} theme={props.theme} />
      </View> : null}
      {props.punch || props.hours ? <View style={blockStyle}>
        {matrix ? props.headings.weekdayHour : props.headings.byHour}
        {matrix && props.punch ? <DotGrid showReadout={false} {...props.punch} testID={`${props.testID}.punchcard`} theme={props.theme} />
          : props.hours ? <StackedSeriesChart {...props.hours} testID={`${props.testID}.hours`} theme={props.theme} /> : null}
      </View> : null}
    </View>
    {props.footer}
  </View>;
}
