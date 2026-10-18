import Color from 'color';
import { describe, expect, it } from 'vitest';
import { resolveWallpaperHaze, WALLPAPER_HAZE_LAYERS } from './wallpaperHaze';

const PAGE = '#ffffff';
const INK = '#1c1c1e';
const grey = (luminance: number) => {
    const value = luminance <= 0.0031308 ? luminance * 12.92 : 1.055 * luminance ** (1 / 2.4) - 0.055;
    return Color.rgb(value * 255, value * 255, value * 255);
};
/** The ground a head line stands on where the picture is `luminance`, under the haze's veil. */
const veiled = (luminance: number, veil: ReturnType<typeof resolveWallpaperHaze>['veil']) =>
    veil ? grey(luminance).mix(Color(veil.color), veil.alpha) : grey(luminance);
const band = { x: 0.36, y: 0.17 };

describe('the Wallpaper haze is the head lines\' legibility device', () => {
    // A bright sky over dark land: the theme ink holds at the centre and fails at the band's edges.
    const mixed = { dark: 0.035, light: 0.82, focus: 0.5 };
    // A night picture under the light theme.
    const night = { dark: 0.004, light: 0.3, focus: 0.01 };

    it('with the default look keeps the theme ink and veils toward the page just enough for small head lines, across the whole band', () => {
        for (const heads of [mixed, night]) {
            const haze = resolveWallpaperHaze({ heads, page: PAGE, primary: INK, column: band, adaptive: true });
            expect(haze.ink).toBe('theme');
            expect(haze.veil?.color).toBe(PAGE);
            expect(Color(INK).contrast(veiled(heads.dark, haze.veil))).toBeGreaterThanOrEqual(4.5);
            // Just enough: a visibly weaker veil would fail.
            expect(Color(INK).contrast(veiled(heads.dark, { ...haze.veil!, alpha: haze.veil!.alpha - 0.04 }))).toBeLessThan(4.5);
            // The band's farthest corners stand inside the veil's solid core; the soft layers stay as composed.
            const veil = haze.veil!;
            expect(Math.hypot(band.x / veil.rx, band.y / veil.ry)).toBeLessThanOrEqual(veil.solid + 1e-9);
            expect(haze.layers).toBe(WALLPAPER_HAZE_LAYERS);
        }
    });

    it('keeps the haze as composed where the head lines already read', () => {
        expect(resolveWallpaperHaze({ heads: { dark: 0.4, light: 0.9, focus: 0.7 }, page: PAGE, primary: INK, column: band, adaptive: true }))
            .toEqual({ layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'theme' });
    });

    it('applies a person\'s own look exactly as set: no veil, and the page colour only where the picture runs hard against the theme', () => {
        expect(resolveWallpaperHaze({ heads: mixed, page: PAGE, primary: INK, column: band, adaptive: false }))
            .toEqual({ layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'theme' });
        expect(resolveWallpaperHaze({ heads: night, page: PAGE, primary: INK, column: band, adaptive: false }))
            .toEqual({ layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'page' });
        expect(resolveWallpaperHaze({ heads: undefined, page: PAGE, primary: INK, column: band, adaptive: true }))
            .toEqual({ layers: WALLPAPER_HAZE_LAYERS, veil: null, ink: 'theme' });
    });
});
