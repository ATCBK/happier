import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StackedSeriesChart, type StackedSeriesChartProps } from '../../data/StackedSeriesChart.js';

export type UsageDailyChartProps = Readonly<{
  theme: StackedSeriesChartProps['theme'];
  chart: Omit<StackedSeriesChartProps, 'theme' | 'testID' | 'variant'>;
  gap: number;
  footer?: ReactNode;
  testID: string;
}>;

/** Daily's shared presentation; the host supplies admitted series, labels and controls. */
export function UsageDailyChart(props: UsageDailyChartProps) {
  return <View style={{ gap: props.gap }} testID={`${props.testID}.daily`}>
    <StackedSeriesChart {...props.chart} testID={`${props.testID}.chart`} theme={props.theme} variant="bar" />
    {props.footer}
  </View>;
}
