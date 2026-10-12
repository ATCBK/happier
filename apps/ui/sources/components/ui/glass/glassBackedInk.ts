import * as React from 'react';
import { Platform } from 'react-native';

import { parseThemeColor } from '@/theme/parseThemeColor';

/** Faint ink on backed glass is primary ink at this share; the web stylesheet token uses the same mix. */
export const GLASS_BACKED_SECONDARY_INK_SHARE = 0.7;

export type GlassBackedInk = Readonly<{
  themeSecondary: string;
  secondary: string;
}>;

/** Set by GlassSurface on glass with a band, wallpaper or the live desktop behind it; null elsewhere. */
export const GlassBackedInkContext = React.createContext<GlassBackedInk | null>(
  null,
);

/** The stronger faint ink for a backed material, derived from the theme's primary ink. */
export function resolveGlassBackedInk(
  primary: string,
  themeSecondary: string,
): GlassBackedInk {
  const secondary =
    parseThemeColor(primary)
      ?.alpha(GLASS_BACKED_SECONDARY_INK_SHARE)
      .rgb()
      .string() ??
    (Platform.OS === 'web' ? 'var(--colors-text-secondary)' : themeSecondary);
  return { themeSecondary, secondary };
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
      ink !== null && color === ink.themeSecondary ? ink.secondary : color,
    [ink],
  );
}
