import * as React from 'react';
import { Platform } from 'react-native';

import { parseThemeColor } from '@/theme/parseThemeColor';

/** Faint ink on backed glass is primary ink at this share; the web stylesheet token uses the same mix. */
export const GLASS_BACKED_SECONDARY_INK_SHARE = 0.7;
/** Meta is one quiet step below the faint ink, so it keeps its rank on backed glass instead of sinking into the picture. */
export const GLASS_BACKED_TERTIARY_INK_SHARE = 0.55;

export type GlassBackedInk = Readonly<{
  themeSecondary: string;
  secondary: string;
  /** The theme's tertiary ink and the stronger step it takes on backed glass (not on the picture plane, which uses `picture`). */
  tertiary?: Readonly<{ themeInk: string; ink: string }>;
  /** Only where the page itself is the picture: the theme's other quiet inks, and the ink they take there. */
  picture?: Readonly<{ themeInks: readonly string[]; ink: string }>;
}>;

/**
 * Set by GlassSurface on glass with a band, wallpaper or the live desktop behind it, and on the content
 * plane that has cleared over a Wallpaper (the picture is the page); null elsewhere.
 */
export const GlassBackedInkContext = React.createContext<GlassBackedInk | null>(
  null,
);

/** The stronger faint ink for a backed material, derived from the theme's primary ink. */
export function resolveGlassBackedInk(
  primary: string,
  themeSecondary: string,
  themeTertiary: string,
): GlassBackedInk {
  const step = (share: number, webToken: string, themeInk: string) =>
    parseThemeColor(primary)?.alpha(share).rgb().string() ??
    (Platform.OS === 'web' ? webToken : themeInk);
  return {
    themeSecondary,
    secondary: step(GLASS_BACKED_SECONDARY_INK_SHARE, 'var(--colors-text-secondary)', themeSecondary),
    tertiary: { themeInk: themeTertiary, ink: step(GLASS_BACKED_TERTIARY_INK_SHARE, 'var(--colors-text-tertiary)', themeTertiary) },
  };
}

/**
 * The faint inks of a content plane that has cleared over a Wallpaper: text there stands on the picture
 * itself, so its quiet lines (meta, section actions, their glyphs) read in the primary ink, as the lab's
 * Wallpaper heads do (`.at-wall .at-wsh`). Elements on that plane take their own material's ink again.
 */
export function resolveGlassPictureInk(
  primary: string,
  themeSecondary: string,
  themeQuietInks: readonly string[],
): GlassBackedInk {
  return { themeSecondary, secondary: primary, picture: { themeInks: themeQuietInks, ink: primary } };
}

/**
 * Ink adapters (Text, Icon) draw the theme's secondary token as the containing material's faint ink.
 * Callers pass the semantic token from JavaScript, which the web stylesheet scope cannot reach.
 */
export function useGlassBackedInk(): (
  color: string | undefined,
) => string | undefined {
  const ink = React.useContext(GlassBackedInkContext);
  return React.useCallback(
    (color: string | undefined) =>
      ink === null || color === undefined ? color
        : color === ink.themeSecondary ? ink.secondary
        : ink.tertiary !== undefined && color === ink.tertiary.themeInk ? ink.tertiary.ink
        : ink.picture?.themeInks.includes(color) ? ink.picture.ink
        : color,
    [ink],
  );
}
