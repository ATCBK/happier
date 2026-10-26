import type { CSSProperties } from 'react';
import type { TextStyle } from 'react-native';
import type { UnistylesThemes } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { scaleTextStyle } from '@/components/ui/text/uiFontScale';
import { referenceChipCssVariables } from '@/components/ui/referenceChip/referenceChipStyles';

import { MULTI_TEXT_INPUT_BASE_FONT_SIZE } from '../multiTextInputTypography';

type Theme = UnistylesThemes[keyof UnistylesThemes];

/** The editable document's own block: written text wraps where it was typed and never overflows the field. */
export const COMPOSER_EDITOR_CONTENT_STYLE = {
  whiteSpace: 'pre-wrap',
  outline: 'none',
  minHeight: '1lh',
  overflowWrap: 'anywhere',
} as const satisfies CSSProperties;

/**
 * The composer field's box and type on web: the live editor and its static picture (a document row
 * shown before it is edited) draw from this one owner, so the two never differ by a pixel.
 */
export function resolveComposerEditorHostStyle(
  input: Readonly<{
    theme: Theme;
    uiFontScale: unknown;
    textStyle: TextStyle | undefined;
    /** Already stepped for the glass the field stands on. */
    placeholderInk: string | undefined;
    paddingTop?: number;
    paddingBottom?: number;
    paddingLeft?: number;
    paddingRight?: number;
    maxHeight?: number;
  }>,
): CSSProperties {
  const { theme } = input;
  const scaled = scaleTextStyle(
    input.textStyle ?? { fontSize: MULTI_TEXT_INPUT_BASE_FONT_SIZE },
    typeof input.uiFontScale === 'number' ? input.uiFontScale : 1,
  );
  const maxHeight =
    Number.isFinite(input.maxHeight) && (input.maxHeight ?? 0) > 0
      ? input.maxHeight
      : 120;
  return {
    width: '100%',
    position: 'relative',
    boxSizing: 'border-box',
    backgroundColor: 'transparent',
    color: scaled.color ?? theme.colors.input.text,
    caretColor: theme.colors.input.text,
    fontFamily: scaled.fontFamily ?? Typography.default().fontFamily,
    fontSize: scaled.fontSize,
    fontWeight: scaled.fontWeight,
    fontStyle: scaled.fontStyle,
    letterSpacing: scaled.letterSpacing,
    lineHeight: scaled.lineHeight ? `${scaled.lineHeight}px` : '1.4',
    paddingTop: input.paddingTop,
    paddingBottom: input.paddingBottom,
    paddingLeft: input.paddingLeft,
    paddingRight: input.paddingRight,
    maxHeight,
    overflowY: 'auto',
    overscrollBehavior: 'contain',
    scrollbarWidth: 'none',
    '--happier-placeholder-color': input.placeholderInk,
    '--happier-composer-monospace': Typography.mono().fontFamily,
    '--happier-composer-muted': theme.colors.text.secondary,
    '--happier-composer-warning': theme.colors.state.warning.foreground,
    '--happier-composer-success': theme.colors.state.success.foreground,
    '--happier-composer-accent': theme.colors.accent.blue,
    ...referenceChipCssVariables({
      secondary: theme.colors.text.secondary,
      tertiary: theme.colors.text.tertiary,
      accent: theme.colors.accent.blue,
      focus: theme.colors.border.focus,
    }),
  } as CSSProperties;
}
