import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { ActivityBadgeRuntime } from '@/activity/badges/ActivityBadgeRuntime';
import { DesktopActivityOverlayRuntime } from '@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime';

import { flushHookEffects, standardCleanup } from '@/dev/testkit';
import { initializeRootLayoutRuntimeForTests, renderRootLayoutRoute, installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

installRootLayoutRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: <T,>(choices: { web?: T; default?: T }) => choices?.web ?? choices?.default,
            },
            AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/terminal/connect',
            segments: ['(app)', 'terminal', 'connect'],
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    },
});

await initializeRootLayoutRuntimeForTests();

afterEach(() => {
    vi.restoreAllMocks();
    standardCleanup();
});

async function renderRootLayout() {
    const RootLayout = (await import('@/app/(app)/_layout')).default;
    const screen = await renderRootLayoutRoute(RootLayout);
    await flushHookEffects();
    return screen;
}

describe('RootLayout terminal connect shell runtimes', () => {
    it('does not mount shell runtimes on plain web terminal-connect routes', async () => {
        const screen = await renderRootLayout();
        expect(screen.tree.root.findAllByType(ActivityBadgeRuntime)).toHaveLength(0);
        expect(screen.tree.root.findAllByType(DesktopActivityOverlayRuntime)).toHaveLength(0);
    });
});
