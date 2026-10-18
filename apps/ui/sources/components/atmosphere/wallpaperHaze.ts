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
 * The page colour laid over the picture under the head lines: an ellipse around the haze's centre with a solid
 * core (`solid` of its radii `rx`, `ry`, as fractions of the picture) that fades out like the haze's layers.
 */
export type WallpaperHazeVeil = Readonly<{ color: string; alpha: number; rx: number; ry: number; solid: number }>;
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
 * The Wallpaper haze and the ink of the head lines standing on it, decided together.
 *
 * With the default look (`adaptive`: a built-in picture as released) the haze is the head lines' legibility
 * device: they keep the theme's ink, and where it fails small-text contrast against the picture's opposing
 * extreme across the head-line band (`heads`: the column, edges included, at the haze core's height), the haze
 * veils toward the page just far enough. The veil takes the haze core's shape, grown until its solid core holds
 * the whole band (`column`: the band's half-extents around the haze's centre, as fractions of the picture); the
 * soft layers stay as composed, so the picture keeps its texture. The veil leans toward the theme's own ground,
 * so light stays light and dark stays dark.
 *
 * A person's own picture or look keeps the haze exactly as composed; the head lines then read in the theme's ink,
 * or in the page colour where the picture behind them runs hard against the theme (`glassPictureInk`).
 */
export function resolveWallpaperHaze(input: Readonly<{
    heads: GlassAtmosphereTone | undefined;
    page: string;
    primary: string;
    column: Readonly<{ x: number; y: number }>;
    adaptive: boolean;
}>): WallpaperHaze {
    if (!input.adaptive || !input.heads) {
        const ink = glassPictureInk(input.primary, input.page, input.heads?.focus) === input.page ? 'page' : 'theme';
        return { layers: WALLPAPER_HAZE_LAYERS, veil: null, ink };
    }
    const ink = Color(input.primary);
    const page = Color(input.page);
    // The ground nearest the ink in lightness is where it reads worst.
    const worst = greyOf(page.luminosity() > ink.luminosity() ? input.heads.dark : input.heads.light);
    const holds = (alpha: number) => ink.contrast(worst.mix(page, alpha)) >= HEAD_LINE_CONTRAST;
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
        veil: { color: input.page, alpha: Math.ceil(high * 1000) / 1000, rx: core.rx * widen, ry: core.ry * widen, solid: core.solid },
        ink: 'theme',
    };
}
