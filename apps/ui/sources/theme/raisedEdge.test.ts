import Color from 'color';
import { describe, expect, it } from 'vitest';

import { darkTheme, lightTheme } from './index';
import { resolveThemeProfile } from './profiles/resolveThemeProfile';
import type { ThemeProfileV1 } from './profiles/themeProfileTypes';
import { compositeRaisedEdgeColor } from './raisedEdge';

const alpha = (color: string) => Color(color).alpha();
const luminance = (color: string, over: string) => Color(compositeRaisedEdgeColor(over, color)).luminosity();

function profile(mode: 'light' | 'dark', overrides: Record<string, string>): ThemeProfileV1 {
    return {
        schemaVersion: 1,
        id: `edge-${mode}-${Object.keys(overrides).join('-')}`,
        name: 'Edge',
        createdAt: '2026-10-07T00:00:00.000Z',
        updatedAt: '2026-10-07T00:00:00.000Z',
        base: { light: 'light', dark: 'dark' },
        overrides: { light: mode === 'light' ? overrides : {}, dark: mode === 'dark' ? overrides : {} },
    };
}

describe('raised edge colours', () => {
    it('confines the surface finish to a short band at one edge, leaving the middle of a tall surface flat', () => {
        // The ink alpha the finish paints at y px down a surface `height` px tall, as both renderers draw it.
        const alphaAt = (gradient: NonNullable<typeof lightTheme.colors.edge.finishGradient>, y: number, height: number) => {
            const band = gradient.band;
            const from = band ? (band.edge === 'top' ? 0 : height - band.height) : 0;
            const span = band ? band.height : height;
            const t = (y - from) / span;
            if (t < 0 || t > 1) return 0;
            const [a, b] = gradient.locations;
            const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
            return alpha(gradient.colors[0]) * (1 - k) + alpha(gradient.colors[1]) * k;
        };
        for (const theme of [lightTheme, darkTheme]) {
            const finish = theme.colors.edge.finishGradient!;
            for (let y = 60; y <= 540; y += 10) expect(alphaAt(finish, y, 600), `${theme.dark ? 'dark' : 'light'} at ${y}px`).toBe(0);
            // Light shades its bottom edge; dark lights its top edge.
            const edge = theme.dark ? 0 : 600;
            expect(alphaAt(finish, edge, 600)).toBeGreaterThan(0);
            expect(alphaAt(finish, 600 - edge, 600)).toBe(0);
        }
    });
    it('derives one translucent ink overlay independent of the surface underneath', () => {
        const light = lightTheme.colors.edge.finishGradient;
        const dark = darkTheme.colors.edge.finishGradient;
        expect(light?.colors.map(alpha)).toEqual([0, 0.024]);
        expect(dark?.colors.map(alpha)).toEqual([0.025, 0]);
        expect(lightTheme.colors.edge.primaryFinishGradient?.colors.map(alpha)).toEqual([0.14, 0]);
        expect(darkTheme.colors.edge.primaryFinishGradient?.colors.map(alpha)).toEqual([0, 0.025 * (8 / 3)]);
        expect(lightTheme.colors.edge.secondaryFinishGradient?.colors.map(alpha)).toEqual([0, 0.025]);
        expect(darkTheme.colors.edge.secondaryFinishGradient?.colors.map(alpha)).toEqual([0.025 * (8 / 9), 0]);
        for (const theme of [lightTheme, darkTheme]) {
            const fills = theme.colors.button.primary.gradient?.colors ?? [theme.colors.button.primary.background];
            for (const fill of fills) {
                for (const stop of theme.colors.edge.primaryFinishGradient!.colors) {
                    const paint = compositeRaisedEdgeColor(fill, stop);
                    expect(Color(paint).contrast(Color(theme.colors.button.primary.tint))).toBeGreaterThanOrEqual(4.5);
                }
            }
        }
        // A glass coat keeps the backdrop: the finish adds low-alpha ink, never an opaque fill.
        const glass = 'rgba(240, 240, 240, 0.3)';
        expect(alpha(compositeRaisedEdgeColor(glass, light!.colors[1]))).toBeCloseTo(0.317, 3);
        expect(alpha(compositeRaisedEdgeColor(glass, dark!.colors[0]))).toBeCloseTo(0.025 + 0.3 * (1 - 0.025), 2);
    });

    it('keeps the dark finish in the card surface hue with only a small lift over Flat', () => {
        const tinted = resolveThemeProfile({ mode: 'dark', profile: profile('dark', { 'surface.base': '#251C16', 'text.primary': '#A9B1D6' }) });
        for (const theme of [darkTheme, tinted]) {
            const surface = Color(theme.colors.edge.cardFill);
            const ink = Color(theme.colors.effect.surfaceFinish);
            expect(ink.hue()).toBeCloseTo(surface.hue(), -1);
            // The owner rounds the ink to 8-bit channels, which moves low saturation slightly.
            expect(Math.abs(ink.saturationl() - surface.saturationl())).toBeLessThan(1.5);
            expect(ink.lightness()).toBeCloseTo(80, 0);
            expect(ink.alpha()).toBe(0.025);
            const [r, g, b] = Color(compositeRaisedEdgeColor(theme.colors.edge.cardFill, theme.colors.edge.finishGradient!.colors[0])).rgb().array();
            expect(r).toBeGreaterThan(g!);
            expect(g).toBeGreaterThanOrEqual(b!);
            const baseChannels = surface.rgb().array();
            for (const [index, channel] of [r!, g!, b!].entries()) {
                expect(channel - baseChannels[index]!).toBeLessThanOrEqual(4);
            }
        }
    });

    it('keeps existing paint exact when finish strength is transparent and honors profile ink without clamping', () => {
        const flat = resolveThemeProfile({ mode: 'light', profile: profile('light', { 'effect.surfaceFinish': 'transparent' }) });
        expect(flat.colors.edge.finishGradient).toBeNull();
        expect(flat.colors.edge.primaryFinishGradient).toBeNull();
        expect(flat.colors.edge.secondaryFinishGradient).toBeNull();
        const { finishGradient, primaryFinishGradient, secondaryFinishGradient, ...existingPaint } = flat.colors.edge;
        const { finishGradient: ignoredFinish, primaryFinishGradient: ignoredPrimary, secondaryFinishGradient: ignoredSecondary, ...oldPaint } = lightTheme.colors.edge;
        expect(existingPaint).toEqual(oldPaint);
        const strong = resolveThemeProfile({ mode: 'light', profile: profile('light', { 'effect.surfaceFinish': 'rgba(122, 162, 247, 0.5)' }) });
        expect(strong.colors.edge.finishGradient?.colors[1]).toBe('rgba(122, 162, 247, 0.5)');
        const darkStrong = resolveThemeProfile({ mode: 'dark', profile: profile('dark', { 'effect.surfaceFinish': 'rgba(122, 162, 247, 0.5)' }) });
        expect(darkStrong.colors.edge.finishGradient?.colors[0]).toBe('rgba(122, 162, 247, 0.5)');
        expect(darkStrong.colors.edge.secondaryFinishGradient?.colors.map(alpha)).toEqual([0.5 * (8 / 9), 0]);
        const darkFlat = resolveThemeProfile({ mode: 'dark', profile: profile('dark', { 'effect.surfaceFinish': 'transparent' }) });
        const { finishGradient: darkFinish, primaryFinishGradient: darkPrimary, secondaryFinishGradient: darkSecondary, ...darkExistingPaint } = darkFlat.colors.edge;
        const { finishGradient: oldDarkFinish, primaryFinishGradient: oldDarkPrimary, secondaryFinishGradient: oldDarkSecondary, ...darkOldPaint } = darkTheme.colors.edge;
        expect([darkFinish, darkPrimary, darkSecondary]).toEqual([null, null, null]);
        expect(darkExistingPaint).toEqual(darkOldPaint);
    });

    it('composites the edge ink over the border as the eye sees it', () => {
        // white 6% over white 9% is one white at 1 - 0.94 × 0.91.
        expect(compositeRaisedEdgeColor('rgba(255,255,255,0.09)', 'rgba(255,255,255,0.06)')).toBe('rgba(255, 255, 255, 0.145)');
        // A transparent border leaves the ink alone; an unreadable border keeps the border.
        expect(compositeRaisedEdgeColor('transparent', 'rgba(0,0,0,0.04)')).toBe('rgba(0, 0, 0, 0.04)');
        expect(compositeRaisedEdgeColor('var(--x)', 'rgba(0,0,0,0.04)')).toBe('var(--x)');
    });

    it('raises every border role brighter on dark and darker on light, on the theme\'s own ground', () => {
        const darkGround = darkTheme.colors.surface.base;
        const lightGround = lightTheme.colors.surface.base;
        for (const role of ['default', 'surface', 'strong', 'modal'] as const) {
            expect(luminance(darkTheme.colors.edge[role], darkGround)).toBeGreaterThan(luminance(darkTheme.colors.border[role], darkGround));
            expect(luminance(lightTheme.colors.edge[role], lightGround)).toBeLessThan(luminance(lightTheme.colors.border[role], lightGround));
        }
        // A light sheet's ink border carries a visible lip.
        expect(alpha(lightTheme.colors.edge.surface)).toBeGreaterThan(alpha(lightTheme.colors.border.surface));
        // The rim's corner is the theme's own ink: lighter on dark, a breath darker on light, never white.
        expect(luminance(darkTheme.colors.edge.rimHi, darkGround)).toBeGreaterThan(Color(darkGround).luminosity());
        expect(luminance(lightTheme.colors.edge.rimHi, lightGround)).toBeLessThan(Color(lightGround).luminosity());
        // Dark controls stand on a lifted fill; light ones on the page.
        expect(darkTheme.colors.edge.fill).not.toBe(darkTheme.colors.surface.base);
        expect(lightTheme.colors.edge.fill).toBe(lightTheme.colors.surface.base);
    });

    it('steps dark cards and floating surfaces up in the page\'s warm hue, cards at the authored raised surface', () => {
        const card = Color(darkTheme.colors.edge.cardFill);
        const floating = Color(darkTheme.colors.edge.floatingFill);
        // 0.2's ladder: page #191717 → raised #221C1C, a warm step that keeps the hue.
        expect(card.rgb().string()).toBe(Color(darkTheme.colors.surface.elevated).rgb().string());
        for (const fill of [card, floating]) {
            const [r, g, b] = fill.rgb().array();
            expect(r! - g!).toBeGreaterThanOrEqual(5);
            expect(g).toBe(b);
        }
        expect(floating.hue()).toBeCloseTo(card.hue(), 0);
        expect(floating.lightness() - card.lightness()).toBeGreaterThan(1.5);
        expect(floating.lightness() - card.lightness()).toBeLessThan(4);
    });
    it('layers dark surfaces by small steps of light — navigation < page < card < floating — and keeps one paper on light', () => {
        const step = (color: string) => luminance(color, darkTheme.colors.background.canvas);
        expect(step(darkTheme.colors.surface.base)).toBeGreaterThan(step(darkTheme.colors.background.canvas));
        expect(step(darkTheme.colors.edge.cardFill)).toBeGreaterThan(step(darkTheme.colors.surface.base));
        expect(step(darkTheme.colors.edge.floatingFill)).toBeGreaterThan(step(darkTheme.colors.edge.cardFill));
        expect(lightTheme.colors.edge.cardFill).toBe(lightTheme.colors.surface.base);
        expect(lightTheme.colors.edge.floatingFill).toBe(lightTheme.colors.surface.base);
    });

    it('re-derives a theme profile\'s edges from its own ink and borders, and keeps an ink the profile set', () => {
        const tinted = resolveThemeProfile({ mode: 'dark', profile: profile('dark', { 'text.primary': '#A9B1D6', 'border.strong': 'rgba(122,162,247,0.20)' }) });
        expect(tinted.colors.effect.surfaceHighlight).toBe('rgba(169, 177, 214, 0.06)');
        expect(tinted.colors.edge.strong).toBe(compositeRaisedEdgeColor('rgba(122,162,247,0.20)', 'rgba(169, 177, 214, 0.06)'));

        const flat = resolveThemeProfile({ mode: 'light', profile: profile('light', { 'effect.surfaceHighlight': 'transparent' }) });
        expect(flat.colors.effect.surfaceHighlight).toBe('transparent');
        expect(flat.colors.edge.strong).toBe(compositeRaisedEdgeColor(flat.colors.border.strong, 'transparent'));
    });
});
