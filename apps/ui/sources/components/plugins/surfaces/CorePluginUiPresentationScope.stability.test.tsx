import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { Theme } from '@/theme';
import { createMachineFixture, createThemeFixture, renderScreen } from '@/dev/testkit';

const runtime = vi.hoisted(() => ({ theme: null as Theme | null, fontScale: 1 }));
vi.mock('react-native-unistyles', async () => {
    const base = await (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock();
    // Unistyles' real hook creates a new outer Proxy on every render, retaining resolved fields.
    // Model that platform boundary rather than mocking any presentation owner.
    return { ...base, useUnistyles: () => ({
        theme: new Proxy(runtime.theme ?? base.useUnistyles().theme, {}),
        rt: { ...base.useUnistyles().rt, fontScale: runtime.fontScale },
    }) };
});
vi.mock('react-native', async () =>
    (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }));
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const { CorePluginUiPresentationScope } = await import('./CorePluginUiPresentationScope');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useHappierUiLocalization, useHappierUiTheme, useHappierUiAccessibility } = await import('@happier-dev/plugin-ui/environment');
const { useOptionalPluginUiPresentationHost } = await import('../../../../../../packages/plugin-ui/src/presentationHost/context');
const { GlassBackedInkContext, resolveGlassBackedInk, glassQuietThemeInks } = await import('@/components/ui/glass/glassBackedInk');
const { getPreferredLanguage, preloadTranslations, setPreferredLanguageFromSettings } = await import('@/text');

describe('Core presentation producer stability', () => {
    it('keeps public localization and host consumers quiet on Machine publication, but propagates presentation changes', async () => {
        const previous = storage.getState(), language = getPreferredLanguage();
        onTestFinished(() => { storage.setState(previous, true); setPreferredLanguageFromSettings(language); runtime.theme = null; runtime.fontScale = 1; });
        runtime.theme = createThemeFixture();
        const renders = { localization: 0, host: 0, theme: 0, accessibility: 0, parent: 0 };
        let localization!: ReturnType<typeof useHappierUiLocalization>;
        let host!: NonNullable<ReturnType<typeof useOptionalPluginUiPresentationHost>>;
        let theme!: ReturnType<typeof useHappierUiTheme>;
        let accessibility!: ReturnType<typeof useHappierUiAccessibility>;
        function Localization() { renders.localization++; localization = useHappierUiLocalization(); return null; }
        function Host() { renders.host++; host = useOptionalPluginUiPresentationHost()!; return null; }
        function ThemeConsumer() { renders.theme++; theme = useHappierUiTheme(); return null; }
        function Accessibility() { renders.accessibility++; accessibility = useHappierUiAccessibility(); return null; }
        const consumers = <><Localization /><Host /><ThemeConsumer /><Accessibility /></>;
        function MachineParent({ backed = false }: { backed?: boolean }) {
            storage(state => state.machines);
            renders.parent++;
            const ink = React.useMemo(() => backed ? resolveGlassBackedInk(runtime.theme!.colors.text.primary,
                runtime.theme!.colors.text.secondary, glassQuietThemeInks(runtime.theme!.colors)) : null, [backed]);
            return <GlassBackedInkContext.Provider value={ink}>
                <CorePluginUiPresentationScope>{consumers}</CorePluginUiPresentationScope>
            </GlassBackedInkContext.Provider>;
        }
        const screen = await renderScreen(<MachineParent />);
        onTestFinished(() => screen.unmount());
        const settled = { ...renders }, firstLocalization = localization, firstHost = host;
        await act(async () => storage.getState().applyMachines([createMachineFixture({ id: 'unrelated-machine', updatedAt: Date.now() })]));
        expect(renders.parent).toBeGreaterThan(settled.parent);
        expect(renders.localization).toBe(settled.localization);
        expect(renders.host).toBe(settled.host);
        expect(localization).toBe(firstLocalization);
        expect(host).toBe(firstHost);

        // Same-locale theme, material, geometry and accessibility changes must not recreate translate.
        const oldPalette = host.palette;
        runtime.theme = createThemeFixture({ colors: { text: { primary: '#123456' }, surface: { base: '#f1f2f3' } } });
        await screen.update(<MachineParent />);
        expect(theme.colors.text).toBe('#123456');
        expect(host.palette).not.toBe(oldPalette);
        expect(localization).toBe(firstLocalization);
        await screen.update(<MachineParent backed />);
        expect(theme.colors.secondaryText).not.toBe(runtime.theme.colors.text.secondary);
        expect(localization).toBe(firstLocalization);
        runtime.fontScale = 1.4;
        await screen.update(<MachineParent backed />);
        expect(accessibility.textScale).toBe(1.4);
        expect(localization).toBe(firstLocalization);
        const lastHost = host;
        await preloadTranslations('fr');
        await act(async () => setPreferredLanguageFromSettings('fr'));
        expect(localization.locale).toBe('fr');
        expect(localization.translate).not.toBe(firstLocalization.translate);
        expect(host).toBe(lastHost);
    });
});
