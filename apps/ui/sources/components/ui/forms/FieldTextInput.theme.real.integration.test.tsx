/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import Color from 'color';

import { installFormsCommonModuleMocks } from './formsTestHelpers';

installFormsCommonModuleMocks({
    reactNative: async () => vi.importActual('react-native-web'),
    text: async () => vi.importActual('@/text'),
    unistyles: async () => vi.importActual('react-native-unistyles'),
});
vi.unmock('@/components/ui/icons/Icon');

it('updates mounted and newly theme-dependent consumers after adaptive media changes', async () => {
    let mode: 'light' | 'dark' = 'dark';
    const queries = new Map<string, MediaQueryList>();
    const previousMatchMedia = window.matchMedia;
    const previousOrientation = Object.getOwnPropertyDescriptor(screen, 'orientation');
    // Browser media and Screen are genuine platform boundaries. Deliver both matching and
    // nonmatching change events, as a real dark→light preference change does.
    window.matchMedia = (media) => {
        const existing = queries.get(media);
        if (existing) return existing;
        const target = new EventTarget();
        const query = Object.defineProperties(Object.assign(target, {
            media,
            matches: false,
            onchange: null,
            addListener: () => {},
            removeListener: () => {},
        }), {
            matches: { get: () => media === `(prefers-color-scheme: ${mode})` },
        }) satisfies MediaQueryList;
        queries.set(media, query);
        return query;
    };
    Object.defineProperty(screen, 'orientation', { configurable: true, value: { type: 'portrait-primary' } });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        const { StyleSheet, UnistylesRuntime, useUnistyles } = await import('react-native-unistyles');
        const { darkTheme, lightTheme } = await import('@/theme');
        StyleSheet.configure({ themes: { light: lightTheme, dark: darkTheme }, settings: { adaptiveThemes: true, CSSVars: true } });
        const { FieldTextInput } = await import('./FieldTextInput');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { SettingsPageHeader } = await import('@/components/settings/shell/SettingsPageHeader');
        const { SettingsFloatingControlsHost } = await import('@/components/settings/shell/SettingsModalFloatingControls');
        const destinationTitle = 'Connected services';
        function DestinationBody() {
            return <SettingsFloatingControlsHost enabled>
                <SettingsPageHeader title={destinationTitle} />
                <div data-testid="retained-destination-body">Retained</div>
            </SettingsFloatingControlsHost>;
        }
        function DelayedThemeRead(props: Readonly<{ read: boolean }>) {
            const { theme } = useUnistyles();
            return <div data-testid="delayed-theme-read" style={props.read ? { color: theme.colors.chrome.header.foreground } : undefined}>Header</div>;
        }
        const tree = (read: boolean) => <React.StrictMode>
            <FieldTextInput testID="theme-field" accessibilityLabel="Name" value="Draft" onChangeText={() => {}} />
            <DelayedThemeRead read={read} />
            <DestinationInstanceHost tabId="connected-services" ref={{ kind: 'settings', params: { pageId: 'connected-services' } }}
                pathname="/settings/connected-services" focused visible phone={read}
                navigation={{ push: () => {}, replace: () => {}, back: () => {}, canGoBack: () => true }}>
                <DestinationBody />
            </DestinationInstanceHost>
        </React.StrictMode>;
        await act(async () => root.render(tree(false)));
        const input = host.querySelector<HTMLInputElement>('[data-testid="theme-field"]');
        if (!input) throw new Error('Missing real field input');
        expect(UnistylesRuntime.themeName).toBe('dark');
        expect(getComputedStyle(input).color).toBe(Color(darkTheme.colors.text.primary).rgb().string());

        await act(async () => {
            mode = 'light';
            for (const query of queries.values()) {
                if (!query.media.startsWith('(prefers-color-scheme:')) continue;
                const event = new Event('change');
                Object.defineProperties(event, {
                    matches: { value: query.matches },
                    media: { value: query.media },
                });
                query.dispatchEvent(event);
            }
        });

        expect(UnistylesRuntime.themeName).toBe('light');
        expect(getComputedStyle(input).color).toBe(Color(lightTheme.colors.text.primary).rgb().string());
        expect(input.value).toBe('Draft');
        const retainedBody = host.querySelector('[data-testid="retained-destination-body"]');
        if (!retainedBody) throw new Error('Missing retained destination body');
        // Reveal the retained destination's phone chrome after the adaptive change.
        // The separate delayed reader first acquires its theme dependency here.
        await act(async () => root.render(tree(true)));
        const delayed = host.querySelector('[data-testid="delayed-theme-read"]');
        if (!delayed) throw new Error('Missing delayed theme consumer');
        expect(getComputedStyle(delayed).color).toBe(Color(lightTheme.colors.chrome.header.foreground).rgb().string());
        const header = host.querySelector('[data-testid="workspace-destination-header"]');
        if (!header) throw new Error('Missing real retained destination header');
        const title = Array.from(header.querySelectorAll<HTMLElement>('*')).find(node => node.children.length === 0 && node.textContent === destinationTitle);
        if (!title) throw new Error('Missing real retained navigation title');
        const backIcon = header.querySelector('[data-testid="settings-modal-back"] svg');
        if (!backIcon) throw new Error('Missing real retained Back icon');
        expect(getComputedStyle(title).color).toBe(Color(lightTheme.colors.chrome.header.foreground).rgb().string());
        // Native SVG drawing is the shared platform boundary; inspect the ink it receives from the real Icon.
        expect(Color(backIcon.getAttribute('color')!).rgb().string()).toBe(Color(lightTheme.colors.chrome.header.foreground).rgb().string());
        expect(host.querySelector('[data-testid="retained-destination-body"]')).toBe(retainedBody);
        await act(async () => {
            mode = 'dark';
            for (const query of queries.values()) {
                if (!query.media.startsWith('(prefers-color-scheme:')) continue;
                const event = new Event('change');
                Object.defineProperties(event, {
                    matches: { value: query.matches },
                    media: { value: query.media },
                });
                query.dispatchEvent(event);
            }
        });
        expect(UnistylesRuntime.themeName).toBe('dark');
        expect(getComputedStyle(delayed).color).toBe(Color(darkTheme.colors.chrome.header.foreground).rgb().string());
        expect(getComputedStyle(title).color).toBe(Color(darkTheme.colors.chrome.header.foreground).rgb().string());
        expect(Color(backIcon.getAttribute('color')!).rgb().string()).toBe(Color(darkTheme.colors.chrome.header.foreground).rgb().string());
        expect(getComputedStyle(input).color).toBe(Color(darkTheme.colors.text.primary).rgb().string());
    } finally {
        await act(async () => root.unmount());
        host.remove();
        window.matchMedia = previousMatchMedia;
        if (previousOrientation) Object.defineProperty(screen, 'orientation', previousOrientation);
        else Reflect.deleteProperty(screen, 'orientation');
    }
});
