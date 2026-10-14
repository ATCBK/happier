import type { HappierUiTheme } from '../../environment/types.js';
import type { HappierDataPoint } from './dataModel.js';
import { StackedSeriesChart } from './StackedSeriesChart.js';

export type HappierDataChartProps = Readonly<{
  label: string;
  style: 'bar' | 'line';
  points: readonly HappierDataPoint[];
  theme: HappierUiTheme;
  viewportHeight?: number;
  testID?: string;
}>;

/**
 * Public single-series adapter. Geometry, interaction and exact values belong to the series owner.
 * Its points are plain data with no "now", so the series draws in one ink rather than singling out its last bar.
 */
export function HappierDataChart(props: HappierDataChartProps) {
  return <StackedSeriesChart theme={props.theme} label={props.label} variant={props.style} size="full" barEmphasis="none"
    viewportHeight={props.viewportHeight} testID={props.testID}
    series={[{ id: 'value', label: props.label, points: props.points.map((point, index) => ({ ...point, id: String(index) })) }]} />;
}
