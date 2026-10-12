import {
  memo,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from 'react';
import { View } from 'react-native';

import { resolveHappierIconSize } from '../content/Icon.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import type { HappierPortableStyle, HappierStyleProp } from '../portableTypes.js';

/** One line of the row's text; the host draws it on a single line (`numberOfLines={1}`). */
export type HappierWidgetGlanceRowTextProps = Readonly<{
  /** `title`: the row's name (row title step). `meta`: a fact, a tag or a fact-variant label (row meta step). */
  role: 'title' | 'meta';
  /** A path, id or ref: the host's mono face. */
  mono?: boolean;
  color: string;
  style: HappierStyleProp;
  children: ReactNode;
}>;

/** The resolved inks a host draws the row with. */
export type HappierWidgetGlanceRowColors = Readonly<{
  text: string;
  secondaryText: string;
  mutedText: string;
  /** "Needs you": a fact the person must act on. */
  attention: string;
  /** Under the pointer or a press, when the row leads somewhere. */
  pressed: string;
  focus: string;
}>;

/** The host's spacing steps the row is laid out on (core: its density-aware `theme.space`). */
export type HappierWidgetGlanceRowSpace = Readonly<{
  s6: number;
  s8: number;
  s10: number;
}>;

export type HappierWidgetGlanceRowProps = Readonly<{
  /** The host's one-line text owner (it keeps the user's font scale). */
  Text: ComponentType<HappierWidgetGlanceRowTextProps>;
  colors: HappierWidgetGlanceRowColors;
  space: HappierWidgetGlanceRowSpace;
  testID?: string;
  /** The row's mark, drawn by the host (a glyph, a brand mark, a spinner). It stands alone, never on a tile. */
  mark?: ReactElement | null;
  title: string;
  /** `fact` draws the label as a quiet one-line statement (About); `row` is a thing with a name. */
  variant?: 'row' | 'fact';
  /** A short tag on the label's line ("Here"). */
  tag?: string | null;
  /** The second line: where it is and what is happening there. */
  fact?: string | null;
  /** `attention`: the fact needs the person (amber). Healthy state stays quiet. */
  factTone?: 'quiet' | 'attention';
  mono?: boolean;
  trailing?: ReactNode;
  /** Last-known while its source is away. */
  dimmed?: boolean;
  onPress?: (() => void) | null;
  accessibilityLabel?: string;
}>;

/** The mark column: the small glyph step, so titles align whatever the mark's shape. */
const MARK_BOX = resolveHappierIconSize('small');

/**
 * The one row inside a widget body (lab `ai`, `.fact`, `.pj-cr`): a mark, a label with an optional
 * short tag, an optional quiet fact line beneath, and one trailing element. Happier core's widgets and
 * plugin widgets draw their rows with it, so a glance reads the same wherever it is placed. A row that
 * leads somewhere is one pressable; a row with its own control is not.
 */
export const HappierWidgetGlanceRow = memo(function HappierWidgetGlanceRow(
  props: HappierWidgetGlanceRowProps,
): ReactElement {
  const { Text, colors, space } = props;
  const variant = props.variant ?? 'row';
  const content = (
    <>
      {props.mark !== undefined ? (
        <View style={markStyle}>{props.mark}</View>
      ) : null}
      <View style={textColumnStyle}>
        <View style={[titleLineStyle, { gap: space.s6 }]}>
          <Text
            role={variant === 'fact' ? 'meta' : 'title'}
            {...(props.mono ? { mono: true } : {})}
            color={variant === 'fact' ? colors.secondaryText : colors.text}
            style={shrinkingTextStyle}
          >
            {props.title}
          </Text>
          {props.tag ? (
            <Text role="meta" color={colors.mutedText} style={fixedTextStyle}>
              {props.tag}
            </Text>
          ) : null}
        </View>
        {props.fact ? (
          <Text
            role="meta"
            color={
              props.factTone === 'attention'
                ? colors.attention
                : colors.secondaryText
            }
            style={null}
          >
            {props.fact}
          </Text>
        ) : null}
      </View>
      {props.trailing ?? null}
    </>
  );
  const rowStyle: HappierStyleProp = [
    variant === 'fact' ? factRowStyle : itemRowStyle,
    { gap: space.s10 },
    props.dimmed ? dimmedStyle : null,
  ];
  if (!props.onPress) {
    return (
      <View testID={props.testID} style={rowStyle}>
        {content}
      </View>
    );
  }
  return (
    <HappierPressable
      {...(props.testID === undefined ? {} : { testID: props.testID })}
      accessibilityRole="button"
      accessibilityLabel={
        props.accessibilityLabel ??
        [props.title, props.tag, props.fact].filter(Boolean).join(', ')
      }
      onPress={props.onPress}
      style={(state) => [
        rowStyle,
        pressableStyle,
        { paddingHorizontal: space.s8 },
        happierFocusRingStyle({ visible: state.focused, color: colors.focus }),
        state.pressed || state.hovered
          ? { backgroundColor: colors.pressed }
          : null,
      ]}
    >
      {content}
    </HappierPressable>
  );
});

const itemRowStyle = {
  minHeight: 40,
  flexDirection: 'row',
  alignItems: 'center',
  minWidth: 0,
} satisfies HappierPortableStyle;
const factRowStyle = {
  minHeight: 28,
  flexDirection: 'row',
  alignItems: 'center',
  minWidth: 0,
} satisfies HappierPortableStyle;
// The hover wash reaches past the text to the frame's inset; the text keeps its column.
const pressableStyle = { marginHorizontal: -8, borderRadius: 8 } satisfies HappierPortableStyle;
const dimmedStyle = { opacity: 0.6 } satisfies HappierPortableStyle;
const markStyle = {
  width: MARK_BOX,
  alignItems: 'center',
  justifyContent: 'center',
} satisfies HappierPortableStyle;
const textColumnStyle = { flex: 1, minWidth: 0 } satisfies HappierPortableStyle;
const titleLineStyle = {
  flexDirection: 'row',
  alignItems: 'center',
  minWidth: 0,
} satisfies HappierPortableStyle;
const shrinkingTextStyle = { flexShrink: 1, minWidth: 0 } as const;
const fixedTextStyle = { flexShrink: 0 } as const;
