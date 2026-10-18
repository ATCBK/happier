import type { AtmospherePixels, AtmosphereRgb } from '@happier-dev/brand/atmosphere';
import type { GlassAtmosphereTone } from '@/components/ui/glass/glassMaterial';

/** Fractions of the rendered picture (0–1 on each axis). */
export type PictureToneRegion = Readonly<{ x0: number; x1: number; y0: number; y1: number }>;

/** About this many samples describe a region; the picture is smooth at that scale, and the read stays cheap. */
const SAMPLES = 4096;

const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

/** Sorted relative luminances of a region, each pixel seen over the page colour (a dissolved foot reads as page). */
function sampleLuminance(pixels: AtmospherePixels, page: AtmosphereRgb, region: PictureToneRegion): number[] {
    const clampFraction = (value: number) => Math.min(1, Math.max(0, value));
    const x0 = Math.floor(clampFraction(region.x0) * pixels.w);
    const x1 = Math.ceil(clampFraction(region.x1) * pixels.w);
    const y0 = Math.floor(clampFraction(region.y0) * pixels.h);
    const y1 = Math.ceil(clampFraction(region.y1) * pixels.h);
    const width = x1 - x0;
    const height = y1 - y0;
    if (width <= 0 || height <= 0) return [];
    const step = Math.max(1, Math.round(Math.sqrt((width * height) / SAMPLES)));
    const values: number[] = [];
    for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
            const at = (y * pixels.w + x) * 4;
            const alpha = pixels.rgba[at + 3]! / 255;
            const channel = (index: number) => linear(pixels.rgba[at + index]! * alpha + page[index]! * (1 - alpha));
            values.push(0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2));
        }
    }
    return values.sort((a, b) => a - b);
}

/**
 * A card can stand anywhere in the column, so its glass answers to the picture's near-extremes (a sunset's
 * glow, a dark ridge), not its average; the outermost few percent are specks the blur already softens.
 */
const EXTREME = 0.02;

const quantile = (values: readonly number[], fraction: number) =>
    Math.round(values[Math.min(values.length - 1, Math.floor(fraction * values.length))]! * 1000) / 1000;

/**
 * The tone of a rendered picture where content sits: the near-darkest and near-lightest of the content `column`,
 * and the middle of the `focus` region around its centre, where head lines stand. Glass and ink derive their
 * defaults from it.
 */
export function measurePictureTone(pixels: AtmospherePixels, page: AtmosphereRgb, column: PictureToneRegion, focus: PictureToneRegion = column): GlassAtmosphereTone | undefined {
    const values = sampleLuminance(pixels, page, column);
    const centre = sampleLuminance(pixels, page, focus);
    if (values.length === 0 || centre.length === 0) return undefined;
    return { dark: quantile(values, EXTREME), light: quantile(values, 1 - EXTREME), focus: quantile(centre, 0.5) };
}

/** Tones are rounded, so an unchanged picture republishes an equal value. */
export function samePictureTone(a: GlassAtmosphereTone | undefined, b: GlassAtmosphereTone | undefined): boolean {
    return a === b || (a !== undefined && b !== undefined && a.dark === b.dark && a.light === b.light && a.focus === b.focus && a.ink === b.ink);
}
