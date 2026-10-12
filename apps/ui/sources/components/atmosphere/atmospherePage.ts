import { resolveThemeColor } from '@/theme/parseThemeColor';
import type { AtmosphereRgb } from '@happier-dev/brand/atmosphere';

/** The page colour the backdrop renderer dissolves into: the theme's page surface, as the renderer's RGB triple. */
export function atmospherePageRgb(color: string): AtmosphereRgb {
    const [r = 0, g = 0, b = 0] = resolveThemeColor(color).rgb().array();
    return [Math.round(r), Math.round(g), Math.round(b)];
}
