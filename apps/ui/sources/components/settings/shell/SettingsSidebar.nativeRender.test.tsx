import * as React from 'react';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { standardCleanup } from '@/dev/testkit';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        Text: 'Text',
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => '/settings',
        router: { push: vi.fn() },
    }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: async () => {},
}));

const account = createProviderSettingsAccountHarness();
const { storage: storageStore } = await import('@/sync/domains/state/storage');
const { settingsParse } = await import('@/sync/domains/settings/settings');
const { localSettingsParse } = await import('@/sync/domains/settings/localSettings');
const initialSettingsCatalogStorage = storageStore.getState();
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | null = null;

beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://settings-sidebar.test/settings' });
    await account.restore({ settings: { useProfiles: false } });
    storageStore.setState({
        settings: settingsParse({ useProfiles: false }),
        localSettings: localSettingsParse({ devModeEnabled: false, uiFontScale: 1 }),
    });
});

afterEach(async () => {
    await standardCleanup();
    await account.reset();
    storageStore.setState(initialSettingsCatalogStorage, true);
    browser?.restore();
    browser = null;
});

describe('SettingsSidebar real TextInput render', () => {
    it('renders the settings sidebar search input without crashing', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        expect(screen.findByTestId('settings-sidebar.searchInput')).toBeTruthy();
    });
});
