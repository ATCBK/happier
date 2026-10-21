/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { View as NativeView } from 'react-native';

import { installPopoverCommonModuleMocks } from '@/components/ui/popover/popoverTestHelpers';

installPopoverCommonModuleMocks({ reactNative: async () => vi.importActual('react-native-web') });
const mode = vi.hoisted(() => ({ dark: false }));
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { lightTheme, darkTheme } = await import('@/theme');
    const runtime = (theme: typeof lightTheme | typeof darkTheme) => createUnistylesMock({ theme: {
        ...theme,
        colors: { ...theme.colors, surface: { ...theme.colors.surface,
            base: 'var(--colors-surface-base)', elevated: 'var(--colors-surface-elevated)',
        } },
    } });
    const light = await runtime(lightTheme);
    const dark = await runtime(darkTheme);
    return { ...light, useUnistyles: () => mode.dark ? dark.useUnistyles() : light.useUnistyles() };
});

const { View } = await import('react-native');
const { default: AnchoredTooltip } = await import('./AnchoredTooltip');
const { GlassMaterialSettingsProvider } = await import('@/components/ui/glass/useGlassMaterialSettings');
const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
const { lightTheme, darkTheme } = await import('@/theme');

afterEach(() => {
    mode.dark = false;
    document.documentElement.style.removeProperty('--colors-surface-base');
    document.documentElement.style.removeProperty('--colors-surface-elevated');
    vi.restoreAllMocks();
});

it.each(['light', 'dark'] as const)('opens the real %s tooltip with CSS surface tokens and retains its elevated material', async (scheme) => {
    mode.dark = scheme === 'dark';
    const theme = mode.dark ? darkTheme : lightTheme;
    document.documentElement.style.setProperty('--colors-surface-base', theme.colors.surface.base);
    document.documentElement.style.setProperty('--colors-surface-elevated', theme.colors.surface.elevated);
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(1024);
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(768);
    window.dispatchEvent(new Event('resize'));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        x: 100, y: 100, width: 28, height: 28, top: 100, left: 100, right: 128, bottom: 128, toJSON: () => ({}),
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const anchor = React.createRef<NativeView>();
    try {
        await act(async () => {
            root.render(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('auto') }}>
                <View ref={anchor} />
                <AnchoredTooltip anchorRef={anchor} label="Open browser" testID="variable-tooltip" />
            </GlassMaterialSettingsProvider>);
        });
        await vi.waitFor(() => {
            const bubble = document.body.querySelector<HTMLElement>('[data-testid="variable-tooltip"]');
            expect(bubble?.textContent).toContain('Open browser');
            const paint = bubble?.querySelector<HTMLElement>('[data-happy-glass-backdrop="true"]');
            // The named floating coat is solved from the live surface tokens into a concrete color;
            // only the solid material keeps the CSS token spelling (asserted below).
            expect(paint?.style.backgroundColor).toMatch(/^rgba?\(/);
            expect(paint?.style.backgroundColor).not.toContain('var(');
            // JSDOM rejects even literal backdrop-filter. The glass renderer suite verifies that
            // filter before the DOM boundary; here the real tooltip must retain its material coat.
        });
        // Solid restores the same elevated paint, rather than a replacement fill.
        await act(async () => {
            root.render(<GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials('solid') }}>
                <View ref={anchor} />
                <AnchoredTooltip anchorRef={anchor} label="Open browser" testID="variable-tooltip" />
            </GlassMaterialSettingsProvider>);
        });
        const bubble = document.body.querySelector<HTMLElement>('[data-testid="variable-tooltip"]');
        const paint = bubble?.querySelector<HTMLElement>('[data-happy-glass-backdrop="true"]');
        expect(paint?.style.backgroundColor).toContain('var(--colors-surface-elevated)');
    } finally {
        await act(async () => { root.unmount(); });
        container.remove();
    }
});
