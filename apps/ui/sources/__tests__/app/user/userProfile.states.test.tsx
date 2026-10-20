import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const profileState = vi.hoisted(() => ({
    resolveProfile: null as null | ((profile: unknown) => void),
    // A real auth context keeps one credentials object for the session.
    auth: { credentials: { token: 'token' } },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: { id: 'user-1' } }).module;
});
vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({ useAllSessions: () => [] });
});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => profileState.auth,
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => vi.fn() }));
vi.mock('@/track', () => ({ trackFriendsConnect: vi.fn() }));
// The social API is the network boundary.
vi.mock('@/sync/api/social/apiFriends', () => ({
    getUserProfile: vi.fn(() => new Promise((resolve) => {
        profileState.resolveProfile = resolve;
    })),
}));

afterEach(() => {
    profileState.resolveProfile = null;
});

describe('UserProfileScreen states', () => {
    it('keeps the page header while the person loads and when they are not found', async () => {
        const { default: UserProfileScreen } = await import('@/app/(app)/user/[id]');
        const screen = await renderScreen(React.createElement(UserProfileScreen));
        await flushHookEffects({ cycles: 2, turns: 1 });

        // Loading: the page keeps its identity instead of a bare spinner.
        expect(screen.findAllByProps({ testID: 'user-profile.header' }).length).toBeGreaterThan(0);

        await React.act(async () => {
            profileState.resolveProfile?.(null);
            await flushHookEffects({ cycles: 2, turns: 1 });
        });

        expect(screen.getTextContent()).toContain('errors.userNotFound');
        expect(screen.findAllByProps({ testID: 'user-profile.header' }).length).toBeGreaterThan(0);
    });
});
