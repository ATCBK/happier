import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { HappierUiTheme } from '../../../environment/types.js';
import { HAPPIER_SPACE_STEPS as space } from '../../../environment/spacing.js';
import { RankedRows, type RankedRowsProps } from '../../data/RankedRows.js';
import { HappierText } from '../../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../../text/typeRole.js';
import { useOptionalHappierUiTypography } from '../../../environment/context.js';

export type UsageBreakdownBlock = Omit<RankedRowsProps, 'theme' | 'size'> & Readonly<{
  id: string;
  footer?: ReactNode;
}>;
export type UsageBreakdownsModel = Readonly<{ namedByCard?: boolean; blocks: readonly UsageBreakdownBlock[] }>;
export function UsageBreakdownsBody(props: Readonly<{ theme: HappierUiTheme; model: UsageBreakdownsModel; testID?: string; coverage?: ReactNode;
  spacing?: Readonly<{ s10: number; s20: number }> }>) {
  const heading = resolveHappierTypeRoleStyle('body', props.theme, useOptionalHappierUiTypography(), 'semiBold');
  const spacing = props.spacing ?? space;
  return <View style={{ gap: spacing.s20 }} testID={props.testID}>
    {props.model.blocks.map(({ id, footer, ...ranked }) => <View key={id} style={{ gap: spacing.s10 }}>
      {props.model.namedByCard ? null : <HappierText style={{ ...heading, color: props.theme.colors.secondaryText }} accessibilityRole="header">{ranked.label}</HappierText>}
      <RankedRows {...ranked} theme={props.theme} size="full" />
      {footer}
    </View>)}
    {props.coverage}
  </View>;
}
