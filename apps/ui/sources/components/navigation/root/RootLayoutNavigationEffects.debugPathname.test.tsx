import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const INVITATION_TOKEN = 'Zq8nT3vLxK1mWc5RpHd7YbJf2GsA4eUo9iNt6XhC0Vw';

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: `/join/${INVITATION_TOKEN}`,
        segments: ['(app)', 'join', '[token]'],
        router: { replace: vi.fn() },
    }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: false, refreshFromActiveServer: vi.fn(async () => {}) }),
}));
vi.mock('@/hooks/ui/useWebInitialRouteReconcile', () => ({ useWebInitialRouteReconcile: () => {} }));
vi.mock('@/sync/domains/server/url/consumeLegacySessionDeepLinkFromWebLocation', () => ({
    consumeLegacySessionDeepLinkFromWebLocation: () => false,
}));
vi.mock('@/activity/notifications/runtime/useNotificationResponseRouting', () => ({
    useNotificationResponseRouting: () => {},
}));
vi.mock('@/activity/adapters/desktop/runtime/isDesktopActivityOverlayWindowContext', () => ({
    isDesktopActivityOverlayWindowContext: () => false,
}));
vi.mock('@/utils/platform/desktopHost', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/desktopHost')>(),
    invokeDesktopHost: vi.fn(),
    isDesktopHost: () => false,
}));
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text' }));

afterEach(() => {
    standardCleanup();
    vi.unstubAllEnvs();
});

it('keeps a capability link\'s bearer out of the debug pathname readout', async () => {
    vi.stubEnv('EXPO_PUBLIC_DEBUG', '1');
    const { RootLayoutNavigationEffects } = await import('./RootLayoutNavigationEffects');

    const rendered = await renderScreen(<RootLayoutNavigationEffects />);

    const readout = rendered.findByTestId('debug-router-pathname');
    expect(readout).not.toBeNull();
    const text = rendered.getTextContent();
    expect(text).toContain('/join/');
    expect(text).not.toContain(INVITATION_TOKEN);
});
