import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const windowDimsState = vi.hoisted(() => ({ width: 1600, height: 900 }));
const routerMock = createExpoRouterMock();

vi.mock('@/components/settings/shell/SettingsSidebar', () => ({
    // Simulate a bad export in production bundles, which previously crashed /settings.
    SettingsSidebar: undefined,
}));

vi.mock('expo-router', () => ({
    ...routerMock.module,
    Stack: Object.assign(
        (props: any) => React.createElement('Stack', { testID: 'settings-layout-stack' }, props.children),
        { Screen: (props: any) => React.createElement('Stack.Screen', { name: props?.name ?? '' }) },
    ),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
        useWindowDimensions: () => ({ width: windowDimsState.width, height: windowDimsState.height, scale: 2, fontScale: 1 }),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { localSettingsParse } = await import('@/sync/domains/settings/localSettings');
const { default: Layout } = await import('@/app/(app)/settings/_layout');
const { SettingsShell } = await import('@/components/settings/shell/SettingsShell');

afterEach(async () => {
    await standardCleanup();
});

describe('/settings/_layout sidebar crash boundary', () => {
    it('renders without crashing when the sidebar subtree is an invalid element', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        await loadSyncSingletonForTests();
        const initialState = storage.getState();
        storage.setState({ localSettings: localSettingsParse({
            settingsNavSidebarEnabled: true,
            settingsNavSidebarWidthPx: 230,
            settingsNavSidebarWidthBasisPx: 1200,
        }) });
        const screen = await renderScreen(React.createElement(Layout));

        expect(screen.findAllByType(SettingsShell)).toHaveLength(1);
        expect(screen.findByTestId('settings-layout-stack')).toBeTruthy();
        expect(screen.findByTestId('settings-shell.sidebarPane')).toBeNull();
        expect(screen.findAllByTestId('app-crash-restart')).toHaveLength(0);
        expect(storage.getState().localSettings.settingsNavSidebarEnabled).toBe(true);
        storage.setState(initialState, true);
        consoleErrorSpy.mockRestore();
    });
});
