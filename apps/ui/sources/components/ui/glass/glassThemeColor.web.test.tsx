/** @vitest-environment jsdom */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Color from 'color';
import { installFormsCommonModuleMocks } from '@/components/ui/forms/formsTestHelpers';

installFormsCommonModuleMocks({
    reactNative: async () => vi.importActual('react-native-web'),
    unistyles: async () => vi.importActual('react-native-unistyles'),
});

describe('glass paint with real Unistyles theme tokens', () => {
    const previousMatchMedia = window.matchMedia;
    beforeAll(() => {
        // JSDOM lacks the browser media-query boundary required by real Unistyles.
        window.matchMedia = media => Object.assign(new EventTarget(), {
            media, matches: media === '(prefers-color-scheme: light)', onchange: null,
            addListener() {}, removeListener() {},
        }) as MediaQueryList;
    });
    afterAll(() => { window.matchMedia = previousMatchMedia; });
    it('resolves the live card token in each theme at every material parser boundary', async () => {
        const { StyleSheet, UnistylesRuntime } = await import('react-native-unistyles');
        const { lightTheme, darkTheme } = await import('@/theme');
        StyleSheet.configure({ themes: { light: lightTheme, dark: darkTheme }, settings: { initialTheme: 'light', adaptiveThemes: false, CSSVars: true } });
        const { glassElementsCoatColor, glassSurfaceTintColor } = await import('./glassSurfacePaint');
        const { glassPresetMaterials, resolveGlassBackdropMap, readGlassDocumentColor } = await import('./glassMaterial');
        const { resolveGlassSurfaceColor } = await import('./useGlassSurfaceColor');
        const { resolveWebBlurTintColor } = await import('@/components/ui/overlays/resolveWebBlurTintColor');
        const { createAgentInputChipPickerOptionTransientStyles } = await import('@/components/sessions/agentInput/components/agentInputChipPickerOptionStyles');
        const styles = StyleSheet.create(theme => ({ card: { backgroundColor: theme.colors.edge.cardFill } }));
        const settings = { glassSurfaceMaterials: glassPresetMaterials('everywhere') };
        const environment = { atmosphereBehind: 'wallpaper' as const };
        const variable = '--colors-edge-card-fill';
        const previous = document.documentElement.style.getPropertyValue(variable);
        try {
            for (const [mode, theme] of [['light', lightTheme], ['dark', darkTheme]] as const) {
                UnistylesRuntime.setTheme(mode);
                // JSDOM does not evaluate all theme CSS rules; publish the real theme value at the browser boundary.
                document.documentElement.style.setProperty(variable, theme.colors.edge.cardFill);
                const token = styles.card.backgroundColor;
                expect(token).toBe('var(--colors-edge-card-fill)');
                // This is the exact parser failure from the old, unnormalized glass calculation.
                expect(() => Color(token)).toThrow('Unable to parse color from string');
                const ground = glassElementsCoatColor(token, theme.colors.surface.base);
                expect(ground).toBe(token);
                const tint = glassSurfaceTintColor({ color: ground, page: theme.colors.surface.base, ink: theme.colors.text.primary,
                    dark: theme.dark, settings, group: 'card', environment });
                const expectedTint = glassSurfaceTintColor({ color: theme.colors.edge.cardFill, page: theme.colors.surface.base, ink: theme.colors.text.primary,
                    dark: theme.dark, settings, group: 'card', environment });
                expect(Color(readGlassDocumentColor(document, tint) ?? tint).rgb().string()).toBe(Color(expectedTint).rgb().string());
                expect(resolveGlassBackdropMap(settings, 'card', theme.dark, environment, { page: theme.colors.surface.base, solid: token }))
                    .toEqual(resolveGlassBackdropMap(settings, 'card', theme.dark, environment, { page: theme.colors.surface.base, solid: theme.colors.edge.cardFill }));
                expect(resolveGlassSurfaceColor(token, 'card', settings, environment, true, false))
                    .toBe(resolveGlassSurfaceColor(theme.colors.edge.cardFill, 'card', settings, environment, true, false));
                expect(resolveWebBlurTintColor({ surfaceColor: token, dark: theme.dark }))
                    .toBe(Color(theme.colors.edge.cardFill).alpha(theme.dark ? 0.20 : 0.25).rgb().string());
                expect(createAgentInputChipPickerOptionTransientStyles({ colors: {
                    ...theme.colors, surface: { ...theme.colors.surface, base: token },
                } }).optionRowHovered.backgroundColor).toBe(Color(theme.colors.edge.cardFill).alpha(0.8).rgb().string());
            }
        } finally {
            UnistylesRuntime.setTheme('light');
            if (previous) document.documentElement.style.setProperty(variable, previous);
            else document.documentElement.style.removeProperty(variable);
        }
    });

    it('preserves a valid CSS material expression when a renderer cannot parse it numerically', async () => {
        const { resolveGlassSurfaceColor } = await import('./useGlassSurfaceColor');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { glassSurfaceBackgroundColor } = await import('./glassSurfacePaint');
        const { lightTheme } = await import('@/theme');
        // The paint owner produces CSS color-mix for web coats; it is not a Color-library input.
        const paint = glassSurfaceBackgroundColor(lightTheme.colors.edge.cardFill, 'card', false, true, 0.5);
        const settings = { glassSurfaceMaterials: glassPresetMaterials('everywhere') };
        expect(resolveGlassSurfaceColor(paint, 'floating', settings, {}, true, false)).toBe(paint);
        const variable = '--colors-edge-card-fill';
        const previous = document.documentElement.style.getPropertyValue(variable);
        try {
            document.documentElement.style.setProperty(variable, paint);
            const token = `var(${variable})`;
            expect(resolveGlassSurfaceColor(token, 'floating', settings, {}, true, false)).toBe(token);
            document.documentElement.style.removeProperty(variable);
            expect(resolveGlassSurfaceColor(token, 'floating', settings, {}, true, false)).toBe(token);
        } finally {
            if (previous) document.documentElement.style.setProperty(variable, previous);
            else document.documentElement.style.removeProperty(variable);
        }
    });
});
