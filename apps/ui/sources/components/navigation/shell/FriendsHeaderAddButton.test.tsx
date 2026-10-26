import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const testState = vi.hoisted(() => ({
    routerPush: vi.fn(),
    trackFriendsSearch: vi.fn(),
    readinessState: { isReady: true },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: testState.routerPush }),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.web ?? options.default },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: { colors: { chrome: { header: { foreground: 'foreground' } } } },
    });
});

vi.mock('@/hooks/server/useFriendsIdentityReadiness', () => ({
    useFriendsIdentityReadiness: () => ({ isReady: testState.readinessState.isReady }),
}));

vi.mock('@/track', () => ({
    trackFriendsSearch: testState.trackFriendsSearch,
}));

vi.mock('@/components/ui/icons/Icon', () => ({
    Icon: 'Icon',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

describe('FriendsHeaderAddButton', () => {
    beforeEach(() => {
        testState.routerPush.mockClear();
        testState.trackFriendsSearch.mockClear();
        testState.readinessState.isReady = true;
    });

    it('opens the mobile add-friend search flow', async () => {
        const { FriendsHeaderAddButton } = await import('./FriendsHeaderAddButton');
        const screen = await renderScreen(<FriendsHeaderAddButton testID="friends-add" />);
        const button = screen.findByTestId('friends-add');
        if (!button) throw new Error('friends add button not found');
        button.props.onPress();

        expect(testState.trackFriendsSearch).toHaveBeenCalledOnce();
        expect(testState.routerPush).toHaveBeenCalledWith('/friends/search');
    });

    it('keeps the action disabled until the friends identity is ready', async () => {
        testState.readinessState.isReady = false;
        const { FriendsHeaderAddButton } = await import('./FriendsHeaderAddButton');
        const screen = await renderScreen(<FriendsHeaderAddButton testID="friends-add" />);
        const button = screen.findByTestId('friends-add');
        if (!button) throw new Error('friends add button not found');

        expect(button.props.disabled).toBe(true);
        expect(button.props.accessibilityState).toEqual({ disabled: true });
    });
});
