/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import Color from 'color';
import { installFormsCommonModuleMocks } from '@/components/ui/forms/formsTestHelpers';

installFormsCommonModuleMocks({
    reactNative: async () => vi.importActual('react-native-web'),
    unistyles: async () => vi.importActual('react-native-unistyles'),
});

it('follows repeated adaptive scheme changes in concrete card paint and number ink without remounting', async () => {
    let mode: 'light' | 'dark' = 'light';
    const queries = new Map<string, MediaQueryList>();
    const previousMatchMedia = window.matchMedia;
    const previousOrientation = Object.getOwnPropertyDescriptor(screen, 'orientation');
    // Media events and CSS custom-property resolution are browser boundaries. JSDOM does not
    // evaluate media-query CSS; publish the matching variable as the browser CSS engine does.
    window.matchMedia = media => {
        const existing = queries.get(media);
        if (existing) return existing;
        const target = Object.assign(new EventTarget(), { media, onchange: null,
            addListener(listener: EventListener) { this.addEventListener('change', listener); },
            removeListener(listener: EventListener) { this.removeEventListener('change', listener); } });
        Object.defineProperty(target, 'matches', { get: () => media === `(prefers-color-scheme: ${mode})` });
        const query = target as MediaQueryList;
        queries.set(media, query);
        return query;
    };
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { type: 'portrait-primary' } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const variable = '--qa-card';
    const previousVariable = document.documentElement.style.getPropertyValue(variable);
    try {
        const { StyleSheet, useUnistyles } = await import('react-native-unistyles');
        const { lightTheme, darkTheme } = await import('@/theme');
        StyleSheet.configure({ themes: { light: lightTheme, dark: darkTheme }, settings: { initialTheme: 'light', CSSVars: true } });
        const { initializeThemeRuntimeAppearance } = await import('@/theme/profiles/themeProfileRuntime');
        initializeThemeRuntimeAppearance({ themePreference: 'adaptive', themeProfiles: {
            profiles: [], activeProfileIds: { light: null, dark: null },
        }, style: null }, { light: lightTheme, dark: darkTheme });
        const { useGlassSurfaceColor, useGlassMaterialColorResolver } = await import('./useGlassSurfaceColor');
        const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
        const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
        const { glassPresetMaterials } = await import('./glassMaterial');
        const { useWebRootCanvasPresentation } = await import('@/theme/useWebRootCanvasPresentation');
        const settings = { glassSurfaceMaterials: { ...glassPresetMaterials('everywhere'), content: { blur: 'strong' as const, opacity: 0.5 } } };
        function Card() {
            useWebRootCanvasPresentation(false);
            const { theme } = useUnistyles();
            const card = useGlassSurfaceColor(`var(${variable})`, 'content', false, true, false);
            const resolve = useGlassMaterialColorResolver();
            const sibling = React.useMemo(() => resolve({ color: `var(${variable})`, nested: false }), [resolve]);
            return <div data-testid="card" style={{ backgroundColor: card }}>
                <span data-testid="number" style={{ color: theme.colors.text.primary }}>1.4M</span>
                <div data-testid="sibling" style={{ backgroundColor: sibling }} />
            </div>;
        }
        document.documentElement.style.setProperty(variable, lightTheme.colors.surface.base);
        await act(async () => root.render(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
            <GlassMaterialSettingsProvider value={settings}><Card /></GlassMaterialSettingsProvider>
        </GlassRuntimeEnvironmentProvider>));
        const card = host.querySelector<HTMLElement>('[data-testid="card"]')!;
        const number = host.querySelector<HTMLElement>('[data-testid="number"]')!;
        const sibling = host.querySelector<HTMLElement>('[data-testid="sibling"]')!;
        for (const next of ['dark', 'light', 'dark'] as const) {
            const theme = next === 'dark' ? darkTheme : lightTheme;
            await act(async () => {
                mode = next;
                document.documentElement.style.setProperty(variable, theme.colors.surface.base);
                for (const query of queries.values()) {
                    if (!query.media.startsWith('(prefers-color-scheme:')) continue;
                    const event = new Event('change');
                    Object.defineProperties(event, { matches: { value: query.matches }, media: { value: query.media } });
                    query.dispatchEvent(event);
                }
            });
            expect(getComputedStyle(number).color).toBe(Color(theme.colors.text.primary).rgb().string());
            expect(getComputedStyle(document.body).backgroundColor).toBe(Color(theme.colors.background.canvas).rgb().string());
            const paint = Color(theme.colors.surface.base).alpha(0.5).rgb().string();
            expect(getComputedStyle(card).backgroundColor).toBe(paint);
            expect(getComputedStyle(sibling).backgroundColor).toBe(paint);
            expect(host.querySelector('[data-testid="number"]')).toBe(number);
        }
    } finally {
        await act(async () => root.unmount());
        host.remove();
        document.documentElement.style.setProperty(variable, previousVariable);
        window.matchMedia = previousMatchMedia;
        if (previousOrientation) Object.defineProperty(screen, 'orientation', previousOrientation);
        else Reflect.deleteProperty(screen, 'orientation');
    }
});

it('keeps the material root as the live anchor and preserves its pointer boundary across tier changes', async () => {
    const previousMatchMedia = window.matchMedia;
    const previousOrientation = Object.getOwnPropertyDescriptor(screen, 'orientation');
    // JSDOM does not expose the native browser media/orientation boundary.
    window.matchMedia = media => Object.assign(new EventTarget(), {
        media, matches: media === '(prefers-color-scheme: light)', onchange: null, addListener() {}, removeListener() {},
    }) as MediaQueryList;
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { type: 'portrait-primary' } });
    const { View } = await import('react-native');
    const { StyleSheet } = await import('react-native-unistyles');
    const { lightTheme, darkTheme } = await import('@/theme');
    StyleSheet.configure({ themes: { light: lightTheme, dark: darkTheme }, settings: { adaptiveThemes: false, initialTheme: 'light', CSSVars: true } });
    const { GlassSurface } = await import('./GlassSurface');
    const { GlassMaterialSettingsProvider } = await import('./useGlassMaterialSettings');
    const { GlassRuntimeEnvironmentProvider } = await import('./glassRuntimeEnvironment');
    const { glassPresetMaterials } = await import('./glassMaterial');
    const anchor = React.createRef<React.ComponentRef<typeof View>>();
    const enter = vi.fn();
    const leave = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const scene = (preset: 'auto' | 'solid') => <GlassMaterialSettingsProvider value={{ glassSurfaceMaterials: glassPresetMaterials(preset) }}>
        <GlassRuntimeEnvironmentProvider value={{ atmosphereBehind: 'wallpaper' }}>
            <GlassSurface ref={anchor} collapsable={false} testID="material-anchor" surfaceGroup="card" onPointerEnter={enter} onPointerLeave={leave}>
                <View testID="anchor-child" />
            </GlassSurface>
        </GlassRuntimeEnvironmentProvider>
    </GlassMaterialSettingsProvider>;
    try {
        await act(async () => root.render(scene('auto')));
        const node = host.querySelector<HTMLElement>('[data-testid="material-anchor"]')!;
        expect(anchor.current).toBe(node);
        await act(async () => node.dispatchEvent(new MouseEvent('pointerover', { bubbles: true })));
        expect(enter).toHaveBeenCalledOnce();
        await act(async () => node.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })));
        expect(leave).toHaveBeenCalledOnce();
        await act(async () => root.render(scene('solid')));
        expect(anchor.current).toBe(node);
        expect(host.querySelector('[data-testid="material-anchor"]')).toBe(node);
        expect(node.querySelector('[data-testid="anchor-child"]')).not.toBeNull();
    } finally {
        await act(async () => root.unmount());
        host.remove();
        window.matchMedia = previousMatchMedia;
        if (previousOrientation) Object.defineProperty(screen, 'orientation', previousOrientation);
        else Reflect.deleteProperty(screen, 'orientation');
    }
    expect(anchor.current).toBeNull();
});
