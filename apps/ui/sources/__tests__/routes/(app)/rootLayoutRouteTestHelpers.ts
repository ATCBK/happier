import { vi } from 'vitest';
import type * as React from 'react';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createRealAppRouteElement, renderRealAppRoute } from '@/dev/testkit/render/renderRealAppRoute';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';

export const initializeRootLayoutRuntimeForTests = initializeRealAppRuntimeForTests;

const routeCredentials: AuthCredentials = { token: 'e30.eyJzdWIiOiJhY2NvdW50LWEifQ.signature' };

export async function rootLayoutRouteElement(Screen: React.ComponentType, credentials: AuthCredentials | null = routeCredentials) {
    const { RootLayoutRouteContexts } = await import('./rootLayoutRouteContexts');
    return createRealAppRouteElement(Screen, credentials, { contextWrapper: RootLayoutRouteContexts });
}

export async function renderRootLayoutRoute(Screen: React.ComponentType, credentials: AuthCredentials | null = routeCredentials) {
    const { RootLayoutRouteContexts } = await import('./rootLayoutRouteContexts');
    return renderRealAppRoute(Screen, credentials, { contextWrapper: RootLayoutRouteContexts });
}

type RootLayoutRouteModuleFactory = () => unknown | Promise<unknown>;
type InstallRootLayoutRouteCommonModuleMocksOptions = Readonly<{
    reactNative?: RootLayoutRouteModuleFactory;
    router?: RootLayoutRouteModuleFactory;
    unistyles?: RootLayoutRouteModuleFactory;
    text?: RootLayoutRouteModuleFactory;
}>;

const rootLayoutRouteModuleState = vi.hoisted(() => ({
    options: {
        reactNative: undefined as RootLayoutRouteModuleFactory | undefined,
        router: undefined as RootLayoutRouteModuleFactory | undefined,
        unistyles: undefined as RootLayoutRouteModuleFactory | undefined,
        text: undefined as RootLayoutRouteModuleFactory | undefined,
    },
}));

export function installRootLayoutRouteCommonModuleMocks(
    options: InstallRootLayoutRouteCommonModuleMocksOptions = {},
) {
    rootLayoutRouteModuleState.options = {
        reactNative: options.reactNative,
        router: options.router,
        unistyles: options.unistyles,
        text: options.text,
    };

    // Expo's published CJS serializer otherwise requires an unrelated native
    // entrypoint outside Vitest's platform aliases. Keep its real path logic.
    vi.mock('expo-router/build/fork/getPathFromState', async () => {
        const { loadInstalledExpoPathSerializer } = await import('@/dev/testkit/runtime/installedExpoPathSerializer');
        return loadInstalledExpoPathSerializer();
    });

    vi.mock('expo-router', async () => {
        const activeOptions = rootLayoutRouteModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            pathname: '/',
            segments: ['(app)'],
            router: {
                push: vi.fn(),
                replace: vi.fn(),
                back: vi.fn(),
                setParams: vi.fn(),
            },
        }).module;
    });

    vi.mock('react-native', async () => {
        const activeOptions = rootLayoutRouteModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: <T,>(choices: { ios?: T; default?: T; web?: T }) =>
                    choices?.ios ?? choices?.default ?? choices?.web,
            },
            AppState: {
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
        });
    });

    vi.mock('react-native-unistyles', async () => {
        const activeOptions = rootLayoutRouteModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    });

    vi.mock('@/text', async () => {
        const activeOptions = rootLayoutRouteModuleState.options;
        if (activeOptions.text) {
            return await activeOptions.text();
        }

        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock();
    });
}
