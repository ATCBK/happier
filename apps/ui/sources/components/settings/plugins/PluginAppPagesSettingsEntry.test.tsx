import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

const routerPush = vi.hoisted(() => vi.fn());
const activatePluginAppPage = vi.hoisted(() => vi.fn());
const extraPages = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'View' });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: routerPush } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => `localized:${key}` });
});

vi.mock('@/components/appShell/plugins/pluginAppPageNavigation', () => ({
    usePluginAppPageLaunchInputStaging: () => vi.fn(() => true),
    usePluginAppPageCatalogActivationHandler: () => activatePluginAppPage,
}));

vi.mock('@/components/appShell/destinations/compactAppDestinationCatalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/components/appShell/destinations/compactAppDestinationCatalog')>()),
    useCompactAppDestinations: () => [{
        kind: 'plugin',
        container: 'appPage',
        id: 'plugin:acme.notes:notes',
        destination: { pluginId: 'acme.notes', localId: 'notes' },
        title: 'Notes',
        icon: 'note',
        placement: { kind: 'rail', region: 'plugins' },
        activation: 'navigate',
        order: 10,
        routePath: '/plugins/acme.notes/notes',
        availability: 'unavailable',
        unavailableReason: 'feature_disabled',
        badge: { label: 'Preview', tone: 'accent' },
    }, {
        kind: 'plugin',
        container: 'appPage',
        id: 'plugin:acme.board:board',
        destination: { pluginId: 'acme.board', localId: 'board' },
        title: 'Board',
        icon: 'grid',
        placement: { kind: 'rail', region: 'plugins' },
        activation: 'navigate',
        order: 20,
        routePath: '/plugins/acme.board/board',
        availability: 'available',
    }, ...extraPages.value],
}));

afterEach(() => {
    standardCleanup();
    extraPages.value = [];
    routerPush.mockClear();
    activatePluginAppPage.mockClear();
});

// Load real screen owners after boundary setup, outside behavior deadlines.
const { PluginAppPagesSettingsEntry } = await import('./PluginAppPagesSettingsEntry');

describe('PluginAppPagesSettingsEntry', () => {
    it('says a reason shared by every unavailable page once, under the section, not on each row', async () => {
        extraPages.value = [{
            kind: 'plugin', container: 'appPage', id: 'plugin:acme.log:log',
            destination: { pluginId: 'acme.log', localId: 'log' }, title: 'Log', icon: 'note',
            placement: { kind: 'rail', region: 'plugins' }, activation: 'navigate', order: 30,
            routePath: '/plugins/acme.log/log', availability: 'unavailable', unavailableReason: 'feature_disabled',
        }];
        const screen = await renderScreen(<PluginAppPagesSettingsEntry />);
        const text = screen.getTextContent();
        expect(text.split('localized:pluginRuntime.disabledByPolicy')).toHaveLength(2);
        expect(screen.findAllByTestId('settings.plugins.appPages.plugin:acme.log:log')[0]?.props.subtitle).toBeUndefined();
        expect(screen.findAllByTestId('settings.plugins.appPages.plugin:acme.log:log')[0]?.props.disabled).toBe(true);
    });

    it('renders localized plugin-runtime copy instead of the raw unavailable reason', async () => {
        const screen = await renderScreen(<PluginAppPagesSettingsEntry />);
        // The outermost instance with the testID is the real Item row, so its
        // props are the copy this entry hands the row.
        const entry = screen.findAllByTestId('settings.plugins.appPages.plugin:acme.notes:notes')[0];

        expect(entry?.props.subtitle).toBe('localized:pluginRuntime.disabledByPolicy');
        expect(screen.getTextContent()).not.toContain('feature_disabled');
        expect(entry?.props.rightElement).toBeTruthy();
    });

    it('names an available page by its title alone, never by the raw plugin id', async () => {
        const screen = await renderScreen(<PluginAppPagesSettingsEntry />);
        const entry = screen.findAllByTestId('settings.plugins.appPages.plugin:acme.board:board')[0];

        expect(entry?.props.title).toBe('Board');
        expect(screen.getTextContent()).not.toContain('acme.board');
    });
});
