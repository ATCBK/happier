import * as React from 'react';
import { StyleSheet } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { glassElementsCoatColor } from '@/components/ui/glass/glassSurfacePaint';
import { glassPresetMaterials, resolveGlassBackdropMap, type GlassMaterialSettings } from '@/components/ui/glass/glassMaterial';
import { darkTheme } from '@/theme';
import { ThemePalettePreview } from './ThemeModePreview';

// Only the web host boundary is substituted; material resolution and painting stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
afterEach(standardCleanup);

describe('Web material miniature', () => {
    it('paints a coat the fixed point had to thicken at the effective opacity the live surface uses, not the material table', async () => {
        const environment = { desktopWindow: true, nativeWindowMaterialLive: true, atmosphereBehind: 'band' as const };
        const c = darkTheme.colors;
        // Dark's warm paint needs a thicker coat than the table's hair of tint: the map carries that opacity.
        for (const [tint, group, floatingOnly] of [[0, 'floating', true], [12, 'floating', true], [50, 'floating', true], [0, 'card', false]] as const) {
            const materials = glassPresetMaterials('auto');
            const settings: GlassMaterialSettings = { glassSurfaceMaterials: materials, glassTintIntensity: tint };
            const solid = group === 'floating' ? c.edge.floatingFill : glassElementsCoatColor(c.edge.cardFill, c.surface.base);
            const effective = resolveGlassBackdropMap(settings, group, true, environment, { page: c.surface.base, solid })?.opacity;
            expect(effective).toBeDefined();
            const screen = await renderScreen(<ThemePalettePreview palette={darkTheme} materials={materials}
                materialSettings={settings} materialEnvironment={environment} floatingOnly={floatingOnly} />);
            const shares = screen.findAllByType('View').map(node => StyleSheet.flatten(node.props.style)?.backgroundColor)
                .map(value => typeof value === 'string' ? / (\d+(?:\.\d+)?)%, transparent\)$/.exec(value)?.[1] : undefined)
                .filter((share): share is string => share !== undefined).map(Number);
            expect(shares.some(share => Math.abs(share - effective! * 100) < 1e-6), `${group} at tint ${tint}`).toBe(true);
            standardCleanup();
        }
    });
});
