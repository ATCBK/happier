import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { HappierUiTheme } from '../../../environment/types.js';
import { HAPPIER_SPACE_STEPS as space } from '../../../environment/spacing.js';
import { OutcomeFunnel, type OutcomeFunnelProps } from '../../data/OutcomeFunnel.js';
import { RankedRows, type RankedRowsProps } from '../../data/RankedRows.js';

export type UsageOutcomesModel =
  | Readonly<{ kind: 'work'; funnel: Omit<OutcomeFunnelProps, 'theme' | 'size'>;
    groups: readonly (Omit<RankedRowsProps, 'theme' | 'size'> & Readonly<{ id: string }>)[] }>
  | Readonly<{ kind: 'count'; count: number; label: string; formatValue: (value: number) => string }>;
export function UsageOutcomesBody(props: Readonly<{ theme: HappierUiTheme; model: UsageOutcomesModel;
  testID?: string; sectionTitle?: ReactNode; empty?: ReactNode; coverage?: ReactNode; sectionGap?: number }>) {
  const { model, theme } = props;
  return <View style={{ gap: 14, minWidth: 0 }} testID={props.testID}>
    {model.kind === 'count' ? <RankedRows theme={theme} label={model.label} size="tile" testID={props.testID}
      valueFormatter={model.formatValue} rows={[{ id: 'merged', label: model.label, value: model.count }]} /> : <>
      <OutcomeFunnel {...model.funnel} theme={theme} size="tile" />
      {model.groups.length === 0 ? props.empty : <View style={{ gap: props.sectionGap ?? space.s10, paddingTop: 14,
        borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.divider }}>
        {props.sectionTitle}
        {model.groups.map(({ id, ...group }) => <RankedRows key={id} {...group} theme={theme} size="tile" />)}
      </View>}
    </>}
    {props.coverage}
  </View>;
}
