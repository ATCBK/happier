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

/** Public single-series adapter. Geometry, interaction and exact values belong to the series owner. */
export function HappierDataChart(props: HappierDataChartProps) {
  return <StackedSeriesChart theme={props.theme} label={props.label} variant={props.style} size="full"
    viewportHeight={props.viewportHeight} testID={props.testID}
    series={[{ id: 'value', label: props.label, points: props.points.map((point, index) => ({ ...point, id: String(index) })) }]} />;
}
