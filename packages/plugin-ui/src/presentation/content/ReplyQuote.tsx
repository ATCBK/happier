import type { ComponentType, ReactElement, ReactNode } from 'react';
import { View } from 'react-native';

import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';

/** Presentation facts only: the caller admits the source and owns navigation. */
export type HappierReplyQuoteSource = Readonly<{
  state: 'available';
  label: string;
  text: string;
  detail?: string;
  onPress?: () => void;
  accessibilityLabel?: string;
}> | Readonly<{
  state: 'unavailable';
  label: string;
  reason: string;
}>;

export type HappierReplyQuoteTextProps = Readonly<{
  role: 'source' | 'quote' | 'detail';
  color: string;
  testID?: string;
  children: ReactNode;
}>;

export type HappierReplyQuoteProps = Readonly<{
  testID?: string;
  source: HappierReplyQuoteSource;
  leading?: ReactNode;
  Text: ComponentType<HappierReplyQuoteTextProps>;
  colors: Readonly<{ text: string; secondaryText: string; border: string; focus: string }>;
  space?: Readonly<Record<'s2' | 's6' | 's8', number>>;
}>;

/** One quiet source quote before a reply, shared by core, Doc threads and plugins. */
export function HappierReplyQuote(props: HappierReplyQuoteProps): ReactElement {
  const { Text, colors, source } = props;
  const space = props.space ?? HAPPIER_SPACE_STEPS;
  const frame = { borderLeftWidth: 2, borderLeftColor: colors.border,
    paddingHorizontal: space.s8, paddingVertical: space.s6, gap: space.s2, minWidth: 0 };
  const content = <>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s6 }}>
      {props.leading}
      <Text role="source" color={colors.secondaryText}>{source.label}</Text>
    </View>
    {source.state === 'available' ? <>
      <Text role="quote" color={colors.text} testID={props.testID ? `${props.testID}.text` : undefined}>{source.text}</Text>
      {source.detail ? <Text role="detail" color={colors.secondaryText}>{source.detail}</Text> : null}
    </> : <Text role="detail" color={colors.secondaryText} testID={props.testID ? `${props.testID}.unavailable` : undefined}>{source.reason}</Text>}
  </>;
  return source.state === 'available' && source.onPress
    ? <HappierPressable testID={props.testID} accessibilityRole="link"
        accessibilityLabel={source.accessibilityLabel ?? [source.label, source.text, source.detail].filter(Boolean).join(', ')}
        onPress={source.onPress} style={state => [frame, happierFocusRingStyle({ visible: state.focused, color: colors.focus })]}>
        {content}
      </HappierPressable>
    : <View testID={props.testID} style={frame}>{content}</View>;
}
