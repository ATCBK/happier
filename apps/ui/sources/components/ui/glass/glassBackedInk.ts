import * as React from 'react';
import { Platform } from 'react-native';

import { parseThemeColor } from '@/theme/parseThemeColor';

/**
 * Faint ink (secondary and tertiary alike) on backed glass is primary ink at this share; the web
 * stylesheet tokens use the same mix. Over a picture a quieter meta step falls below 2:1.
 */
export const GLASS_BACKED_FAINT_INK_SHARE = 0.7;

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
    secondary: step(GLASS_BACKED_FAINT_INK_SHARE, 'var(--colors-text-secondary)', themeSecondary),
    tertiary: { themeInk: themeTertiary, ink: step(GLASS_BACKED_FAINT_INK_SHARE, 'var(--colors-text-tertiary)', themeTertiary) },
  };
}

/**
 * The inks of a content plane that has cleared over a Wallpaper: text there stands on the picture itself,
 * so its quiet lines (meta, section actions, their glyphs) read in the primary ink, as the lab's Wallpaper
 * heads do (`.at-wall .at-wsh`). Where the measured picture runs against the theme (a night sky under the
 * light theme's dark ink), every ink on the plane, the primary included, reads in the page colour instead.
 * Elements on that plane take their own material's ink again.
 */
export function resolveGlassPictureInk(
  input: Readonly<{
    primary: string;
    page: string;
    themeSecondary: string;
    themeQuietInks: readonly string[];
    /** Relative luminance of the picture around the content column's centre, when measured. */
    pictureLuminance?: number;
  }>,
): GlassBackedInk {
  const { primary, themeSecondary, themeQuietInks } = input;
  const ink = pictureInk(primary, input.page, input.pictureLuminance);
  return ink === primary
    ? { themeSecondary, secondary: primary, picture: { themeInks: themeQuietInks, ink: primary } }
    : { themeSecondary, secondary: ink, picture: { themeInks: [primary, ...themeQuietInks], ink } };
}

/** DESIGN.md contrast: body text 4.5:1; large text and secondary lines 3:1. */
const GLASS_PICTURE_BODY_CONTRAST = 4.5;
const GLASS_PICTURE_LARGE_CONTRAST = 3;

/**
 * The theme's ink stays while it keeps large-text contrast on the picture. It turns to the page colour only
 * where it fails even that (a night sky under the light theme) and the page colour reaches body contrast.
 * A mid-tone picture that defeats both (bright sky over dark land) keeps the theme's ink.
 */
function pictureInk(primary: string, page: string, pictureLuminance: number | undefined): string {
  if (pictureLuminance === undefined) return primary;
  const primaryColor = parseThemeColor(primary);
  const pageColor = parseThemeColor(page);
  if (primaryColor === null || pageColor === null) return primary;
  const contrast = (luminance: number) => {
    const [high, low] = [luminance, pictureLuminance].sort((a, b) => b - a);
    return (high! + 0.05) / (low! + 0.05);
  };
  const primaryContrast = contrast(primaryColor.luminosity());
  return primaryContrast < GLASS_PICTURE_LARGE_CONTRAST && contrast(pageColor.luminosity()) >= GLASS_PICTURE_BODY_CONTRAST ? page : primary;
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

/**
 * The theme's own ink tokens for the web stylesheet scope, restored where something stands on its own paint
 * inside a subtree whose inks were rerouted (a surface or a filled control on the picture plane).
 */
export function glassThemeInkWebStyle(text: Readonly<{ primary: string; secondary: string; tertiary: string }>): Record<string, string> {
  return { '--colors-text-primary': text.primary, '--colors-text-secondary': text.secondary, '--colors-text-tertiary': text.tertiary };
}

/**
 * True where a control that paints its own fill (a filled or bordered button) sits on the picture plane:
 * it stands on that fill, not on the picture, so the picture's ink stops at its edge. The control resets
 * `GlassBackedInkContext` for its content (and, on web, the tokens of `glassThemeInkWebStyle`).
 */
export function useGlassOwnFillOnPicture(paintsFill: boolean): boolean {
  return React.useContext(GlassBackedInkContext)?.picture !== undefined && paintsFill;
}
