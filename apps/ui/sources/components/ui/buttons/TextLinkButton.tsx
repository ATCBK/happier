import {
  HAPPIER_PRESS_FEEDBACK_V1,
  HappierPressable,
  happierFocusRingStyle,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** The link's own line: its visible height. The press target grows around it, never the layout. */
const LINE_HEIGHT_PX = happierPageTextMetrics('rowDescription').lineHeight;

/**
 * The press frame on a touch pointer (the same strategy as `IconButton`'s `overhang` frame). **Not
 * `hitSlop`**: react-native-web's `Pressable` never reads it, so a slop target does not exist on touch
 * web. The frame is real box model, grown only above and below the line and given back with negative
 * margins, so the words keep the sentence's line and baseline. It never grows sideways, where it would
 * reach over the words beside it. A precise pointer keeps the words' own box.
 */
function resolveTouchFrame(): Readonly<{
  paddingTop: number;
  paddingBottom: number;
  marginTop: number;
  marginBottom: number;
}> | null {
  const floor = resolveTouchTargetFloorPx();
  if (floor === null) return null;
  const grow = Math.max(0, (floor - LINE_HEIGHT_PX) / 2);
  return grow === 0
    ? null
    : { paddingTop: grow, paddingBottom: grow, marginTop: -grow, marginBottom: -grow };
}

/**
 * An operation written as words inside or beside a sentence: a tertiary choice ("Don't show again"),
 * a disclosure ("More" / "Less"), the one contextual recovery ending a status line ("Ask Happier").
 *
 * It is a button, not navigation: semibold ink (secondary, or primary for `strong`) that underlines on hover, the
 * shared press dip, and the keyboard focus ring. The text keeps its line height, so it sits on the
 * baseline of the sentence it ends; on a touch pointer the press frame reaches the platform minimum
 * above and below the line without taking layout. The focus ring and press dip stay on the words.
 */
export const TextLinkButton = React.memo(function TextLinkButton(
  props: Readonly<{
    label: string;
    onPress: () => unknown;
    /** `quiet` reads as part of the sentence; `strong` is the sentence's one recovery. */
    tone?: 'quiet' | 'strong';
    accessibilityLabel?: string;
    /** A disclosure says whether what it controls is open. */
    expanded?: boolean;
    disabled?: boolean;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const strong = props.tone === 'strong';
  const touchFrame = resolveTouchFrame();
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      expanded={props.expanded}
      disabled={props.disabled}
      onPress={props.onPress}
      style={(state) => ({
        alignSelf: 'flex-start',
        ...touchFrame,
        opacity: state.disabled
          ? 0.4
          : state.pressed
            ? HAPPIER_PRESS_FEEDBACK_V1.opacity
            : 1,
      })}
    >
      {(state) => (
        // The ring outlines the words, never the larger touch frame around them.
        <View
          style={[
            stylesheet.ink,
            happierFocusRingStyle({
              visible: state.focused,
              color: theme.colors.border.focus,
            }),
          ]}
        >
          <Text
            numberOfLines={1}
            style={[
              stylesheet.label,
              strong ? stylesheet.strong : null,
              state.hovered ? stylesheet.hovered : null,
            ]}
          >
            {props.label}
          </Text>
        </View>
      )}
    </HappierPressable>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  ink: {
    borderRadius: 4,
  },
  label: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  strong: {
    color: theme.colors.text.primary,
  },
  hovered: {
    color: theme.colors.text.primary,
    textDecorationLine: 'underline',
  },
}));
