import { StackedSeriesChart, type StackedSeriesChartProps } from './StackedSeriesChart.js';

/** Caller-produced lines and optional between-series bands share the canonical series renderer. */
export type BurnUpChartProps = Omit<StackedSeriesChartProps, 'variant' | 'normalized'>;
export function BurnUpChart(props: BurnUpChartProps) {
  return <StackedSeriesChart {...props} variant="line" />;
}
