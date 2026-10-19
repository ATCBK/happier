import Color from 'color';
import { GLASS_BLUR_RADIUS_PX, type GlassAtmosphereTone } from '@/components/ui/glass/glassMaterial';
import { glassPictureInk } from '@/components/ui/glass/glassBackedInk';

export type WallpaperHazeLayer = Readonly<{ blur: number; rx: number; ry: number; solid: number }>;

/** The existing web Wallpaper haze composition, shared by both platform drawing adapters. */
export const WALLPAPER_HAZE_LAYERS: readonly WallpaperHazeLayer[] = [
    { blur: GLASS_BLUR_RADIUS_PX.regular, rx: 0.4, ry: 0.44, solid: 0.38 },
    { blur: GLASS_BLUR_RADIUS_PX.strong, rx: 0.3, ry: 0.34, solid: 0.3 },
];

/**
 * The page colour laid over the picture: an ellipse around `at` with a solid core (`solid` of its radii `rx`, `ry`;
 * all fractions of the picture) that fades out like the haze's layers.
 */
export type WallpaperHazeVeil = Readonly<{ color: string; alpha: number; at: Readonly<{ x: number; y: number }>; rx: number; ry: number; solid: number }>;
export type WallpaperHaze = Readonly<{
    layers: readonly WallpaperHazeLayer[];
    veil: WallpaperHazeVeil | null;
    /** The ink of the plane the head lines stand on (`GlassAtmosphereTone.ink`). */
    ink: NonNullable<GlassAtmosphereTone['ink']>;
}>;

/** Small head lines ("Customize", "Needs your attention") need body contrast; aim a few percent above it. */
const HEAD_LINE_CONTRAST = 4.5 * 1.03;

const greyOf = (luminance: number) => {
    const linear = Math.min(1, Math.max(0, luminance));
    const value = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
    return Color.rgb(value * 255, value * 255, value * 255);
};

/**
 * The veil's colour: the page's lightness in the picture's own hue, as much of its chroma as that lightness holds.
 * Dimming then deepens a dusk sky instead of greying it; luminance stays the page's, so the strength the head
 * lines need does not change. The light page holds no chroma, so light stays light.
 */
function veilColor(page: string, bandColor: string | undefined): string {
    if (!bandColor) return page;
    const [lightness] = Color(page).lch().array();
    const [, chroma, hue] = Color(bandColor).lch().array();
    // The colour at this lightness, hue and chroma, or null where sRGB cannot show it (the converter clamps).
    const shown = (c: number) => {
        const color = Color.lch(lightness!, c, hue!);
        const [l, back] = color.rgb().lch().array();
        return Math.abs(l! - lightness!) < 0.5 && Math.abs(back! - c) < 0.5 ? color : null;
    };
    let low = 0;
    let high = chroma!;
    if (shown(high)) low = high;
    else for (let step = 0; step < 16; step++) {
        const middle = (low + high) / 2;
        if (shown(middle)) low = middle; else high = middle;
    }
    // Less than a just-noticeable tint (about 2 in chroma: all the light page holds) is the page itself.
    return low < 2 ? page : shown(low)!.rgb().round().string();
}

/**
 * The Wallpaper haze and the ink of the head lines standing on it, decided together.
 *
 * With the default look (`adaptive`: a built-in picture as released) the haze is the head lines' legibility
 * device: they keep the theme's ink, and where it fails small-text contrast against the picture's opposing
 * extreme across the head-line bands (`heads`: the column, edges included, at the haze core's height, both where
 * this surface stands its head lines and at the window's middle, where Home stands them), the haze veils toward
 * the page just far enough. The window's middle band makes the veil one decision per picture and theme, so every
 * surface over the same Wallpaper reads as one look. The veil takes the haze core's shape around `at` (the
 * column's centre at the window's middle), grown until its solid core holds every band and the column the
 * cards rest over (`column`: their half-extents around `at`, as fractions of the picture); the soft layers stay as composed, so the picture keeps
 * its texture. The veil leans toward the theme's own ground,
 * so light stays light and dark stays dark, in the band's own hue (`bandColor`), so a dusk deepens rather than greys.
 *
 * A person's own picture or look keeps the haze exactly as composed; the head lines then read in the theme's ink,
 * or in the page colour where the picture behind them runs hard against the theme (`glassPictureInk`).
 */
export function resolveWallpaperHaze(input: Readonly<{
    heads: GlassAtmosphereTone | undefined;
    page: string;
    primary: string;
    column: Readonly<{ x: number; y: number }>;
    /** The veil's centre, as fractions of the picture. */
    at: Readonly<{ x: number; y: number }>;
    adaptive: boolean;
    /** The mean colour of the head-line band (`measurePictureColor`). */
    bandColor?: string;
}>): WallpaperHaze {
    if (!input.adaptive || !input.heads) {
        const ink = glassPictureInk(input.primary, input.page, input.heads?.focus) === input.page ? 'page' : 'theme';
        return { layers: WALLPAPER_HAZE_LAYERS, veil: null, ink };
    }
    const ink = Color(input.primary);
    const page = Color(input.page);
    const color = veilColor(input.page, input.bandColor);
    const veil = Color(color);
    // The ground nearest the ink in lightness is where it reads worst.
    const worst = greyOf(page.luminosity() > ink.luminosity() ? input.heads.dark : input.heads.light);
    const holds = (alpha: number) => ink.contrast(worst.mix(veil, alpha)) >= HEAD_LINE_CONTRAST;
    if (holds(0)) return { layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'theme' };
    let low = 0;
    let high = 1;
    for (let step = 0; step < 20; step++) {
        const middle = (low + high) / 2;
        if (holds(middle)) high = middle;
        else low = middle;
    }
    const core = WALLPAPER_HAZE_LAYERS[0]!;
    const widen = Math.max(1, Math.hypot(input.column.x / core.rx, input.column.y / core.ry) / core.solid);
    return {
        layers: WALLPAPER_HAZE_LAYERS,
        veil: { color, alpha: Math.ceil(high * 1000) / 1000, at: input.at, rx: core.rx * widen, ry: core.ry * widen, solid: core.solid },
        ink: 'theme',
    };
}
