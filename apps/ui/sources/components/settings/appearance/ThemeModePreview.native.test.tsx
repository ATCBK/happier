import * as React from 'react';
import { Platform, StyleSheet } from 'react-native';
import Color from 'color';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { glassPresetMaterials } from '@/components/ui/glass/glassMaterial';
import { darkTheme, lightTheme } from '@/theme';
import { ThemePalettePreview } from './ThemeModePreview';

// Only the native host boundary is substituted; material resolution and painting stay real.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'android' });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
afterEach(standardCleanup);

describe('Native material miniature', () => {
    it('paints the effective floating coat and honors reduced transparency', async () => {
        expect(Platform.OS).toBe('android');
        const materials = glassPresetMaterials('everywhere');
        for (const reduced of [false, true]) {
            const screen = await renderScreen(<ThemePalettePreview palette={lightTheme} materials={materials}
                materialEnvironment={{ reduceTransparency: reduced, nativeRenderer: true }} floatingOnly />);
            const backgrounds = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style)?.backgroundColor);
            expect(backgrounds.filter(value => typeof value === 'string').join(' | ')).toContain(
                Color(lightTheme.colors.edge.floatingFill).alpha(reduced ? 1 : 0.02).rgb().string(),
            );
            standardCleanup();
        }
    });
    it('paints the miniature composer and bubble from the Elements ladder fill, so the tile follows the card paint', async () => {
        const materials = glassPresetMaterials('everywhere');
        const paints = async (cardFill: string, atmosphereBehind: 'band' | 'none' = 'band') => {
            const palette = { ...darkTheme, colors: { ...darkTheme.colors, edge: { ...darkTheme.colors.edge, cardFill } } };
            const screen = await renderScreen(<ThemePalettePreview palette={palette} materials={materials} materialEnvironment={{ nativeRenderer: true, atmosphereBehind }} />);
            const out = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style)?.backgroundColor)
                .filter((value): value is string => typeof value === 'string').map(value => Color(value).rgb().string());
            standardCleanup();
            return out;
        };
        const blue = await paints('#204060');
        // Composer and bubble: the card fill under the translucent Elements coat.
        const coats = blue.filter(value => Color(value).hex() === '#204060');
        expect(coats).toHaveLength(2);
        coats.forEach(value => expect(Color(value).alpha()).toBeLessThan(1));
        // Over the plain page, Elements land on their solid paint.
        expect((await paints('#204060', 'none')).filter(value => value === Color('#204060').rgb().string())).toHaveLength(2);
        expect(await paints(darkTheme.colors.edge.cardFill)).not.toEqual(blue);
    });
});
