import * as React from 'react';
import type { NativeStackHeaderProps } from '@react-navigation/native-stack';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { setPreferredLanguageFromSettings, t } from '@/text';

import { createHeader } from './Header';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const responsiveState = vi.hoisted(() => ({
    isTablet: false,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'web',
            select: (options: Record<string, unknown>) =>
                options.web ?? options.default ?? options.ios ?? options.android,
        },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/utils/platform/responsive', () => ({
    useHeaderHeight: () => 44,
    useIsTablet: () => responsiveState.isTablet,
}));

vi.mock('@/components/navigation/desktopWindowChrome/DesktopWindowDragRegion', () => ({
    useDesktopWindowDragMouseProps: () => ({
        'data-tauri-drag-region': true,
    }),
}));

vi.mock('@/components/navigation/safeArea/HorizontalSafeArea', () => ({
    useHorizontalSafeAreaContentPadding: () => ({ paddingLeft: 0, paddingRight: 0 }),
}));

describe('createHeader', () => {
    beforeEach(() => {
        responsiveState.isTablet = false;
    });

    it('shows a translated accessible back button at tablet stack index one', async () => {
        responsiveState.isTablet = true;
        const navigation = {
            goBack: vi.fn(),
            getState: () => ({ index: 1 }),
        };

        setPreferredLanguageFromSettings('fr');
        const backLabel = t('common.back');
        const header = createHeader({
            options: {
                headerShown: true,
                headerTitle: 'Account',
                headerTintColor: '#111111',
                headerTitleStyle: {},
                headerShadowVisible: false,
                headerTransparent: false,
                headerStyle: {},
            },
            route: { key: 'settings-account', name: 'settings/account' },
            navigation,
            back: { title: 'Settings' },
        } as unknown as NativeStackHeaderProps);

        const screen = await renderScreen(header as React.ReactElement);
        const backButtons = screen.findAllByType('Pressable');

        expect(backButtons).toHaveLength(1);
        try {
            expect(backButtons[0]?.props.accessibilityRole).toBe('button');
            expect(backButtons[0]?.props.accessibilityLabel).toBe(backLabel);
            backButtons[0]?.props.onPress();
            expect(navigation.goBack).toHaveBeenCalledOnce();
        } finally {
            setPreferredLanguageFromSettings(null);
        }
    });

    it('marks the route header drag and content regions with stable test IDs', async () => {
        const header = createHeader({
            options: {
                headerShown: true,
                title: 'Account',
                headerTitleStyle: {},
                headerShadowVisible: false,
                headerTransparent: false,
                headerStyle: {},
            },
            route: { key: 'settings-account', name: 'settings/account' },
            navigation: {
                goBack: vi.fn(),
                getState: () => ({ index: 0 }),
            },
            back: undefined,
        } as unknown as NativeStackHeaderProps);

        const screen = await renderScreen(header as React.ReactElement);

        expect(screen.findByTestId('desktop-route-header-drag-region')).not.toBeNull();
        expect(screen.findByTestId('desktop-route-header-content-wrapper')).not.toBeNull();
        expect(screen.findByTestId('desktop-route-header-content')).not.toBeNull();
        expect(screen.findByTestId('desktop-route-header-center')).not.toBeNull();
    });

    it('uses a route-owned back action when the stack needs deterministic root navigation', async () => {
        const navigation = {
            goBack: vi.fn(),
            getState: () => ({ index: 0 }),
        };
        const backAction = vi.fn();
        const header = createHeader({
            options: {
                headerShown: true,
                headerTitle: 'Settings',
                headerTintColor: '#111111',
                headerTitleStyle: {},
                headerShadowVisible: false,
                headerTransparent: false,
                headerStyle: {},
                headerBackAction: backAction,
            } as any,
            route: { key: 'settings-index', name: 'settings/index' },
            navigation,
            back: { title: 'Home' },
        } as unknown as NativeStackHeaderProps);

        const screen = await renderScreen(header as React.ReactElement);
        const backButton = screen.findAllByType('Pressable')[0];
        backButton?.props.onPress();

        expect(backAction).toHaveBeenCalledOnce();
        expect(navigation.goBack).not.toHaveBeenCalled();
    });
});
