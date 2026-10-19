import { PetAppShellCompanionMount } from '@/components/pets/runtime/PetAppShellCompanionMount';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

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
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: { colors: { surface: '#fff', header: { background: '#fff', tint: '#000' } } },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key: string) => key });
    },
});

await initializeRootLayoutRuntimeForTests();

afterEach(() => {
    vi.restoreAllMocks();
    standardCleanup();
});

describe('App RootLayout pets', () => {
    it('mounts the ordinary web/app-shell pet companion runtime', async () => {
        const RootLayout = (await import('@/app/(app)/_layout')).default;

        const screen = await renderRootLayoutRoute(RootLayout);
        await flushHookEffects();

        expect(screen.tree.root.findAllByType(PetAppShellCompanionMount)).toHaveLength(1);
    });
});
