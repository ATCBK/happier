import type { ComponentType, ReactElement, ReactNode } from 'react';
import { View, type TextStyle } from 'react-native';

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
  /** The quote is one line: a reminder of what is answered, not a second copy of it. */
  numberOfLines?: number;
  style?: TextStyle;
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

/**
 * One quiet source quote before a reply, shared by core, Doc threads and plugins (lab T2-A):
 * one line of mark, source and the quoted words, cut to the line; pressing it opens the source.
 */
export function HappierReplyQuote(props: HappierReplyQuoteProps): ReactElement {
  const { Text, colors, source } = props;
  const space = props.space ?? HAPPIER_SPACE_STEPS;
  const frame = { borderLeftWidth: 2, borderLeftColor: colors.border,
    paddingHorizontal: space.s8, paddingVertical: space.s2, gap: space.s2, minWidth: 0 };
  const content = <>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.s6, minWidth: 0 }}>
      {props.leading}
      <Text role="source" color={colors.text} numberOfLines={1} style={{ flexShrink: 0, maxWidth: '45%' }}>{source.label}</Text>
      {source.state === 'available'
        ? <Text role="quote" color={colors.secondaryText} numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}
            testID={props.testID ? `${props.testID}.text` : undefined}>{source.text}</Text>
        : <Text role="detail" color={colors.secondaryText} numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}
            testID={props.testID ? `${props.testID}.unavailable` : undefined}>{source.reason}</Text>}
    </View>
    {source.state === 'available' && source.detail ? <Text role="detail" color={colors.secondaryText}>{source.detail}</Text> : null}
  </>;
  return source.state === 'available' && source.onPress
    ? <HappierPressable testID={props.testID} accessibilityRole="link"
        accessibilityLabel={source.accessibilityLabel ?? [source.label, source.text, source.detail].filter(Boolean).join(', ')}
        onPress={source.onPress} style={state => [frame, happierFocusRingStyle({ visible: state.focused, color: colors.focus })]}>
        {content}
      </HappierPressable>
    : <View testID={props.testID} style={frame}>{content}</View>;
}
