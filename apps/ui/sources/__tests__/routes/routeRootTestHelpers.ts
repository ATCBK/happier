import { vi } from 'vitest';

type RouteRootModuleFactory = () => object | Promise<object>;

type InstallRouteRootCommonModuleMocksOptions = Readonly<{
    modal?: RouteRootModuleFactory;
    reactNative?: RouteRootModuleFactory;
    router?: RouteRootModuleFactory;
    text?: RouteRootModuleFactory;
    unistyles?: RouteRootModuleFactory;
}>;

const routeRootModuleState = vi.hoisted(() => ({
    options: {
        modal: undefined as RouteRootModuleFactory | undefined,
        reactNative: undefined as RouteRootModuleFactory | undefined,
        router: undefined as RouteRootModuleFactory | undefined,
        text: undefined as RouteRootModuleFactory | undefined,
        unistyles: undefined as RouteRootModuleFactory | undefined,
    },
}));

export function installRouteRootCommonModuleMocks(
    options: InstallRouteRootCommonModuleMocksOptions = {},
) {
    routeRootModuleState.options = {
        modal: options.modal,
        reactNative: options.reactNative,
        router: options.router,
        text: options.text,
        unistyles: options.unistyles,
    };

    vi.mock('react-native', async () => {

        const activeOptions = routeRootModuleState.options;
        if (activeOptions.reactNative) {
            return await activeOptions.reactNative();
        }

        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');

        return createReactNativeWebMock();
    });

    // Existing callers with a legacy dialog boundary opt in explicitly; root
    // composition uses the real modal owner by default.
    if (options.modal) vi.doMock('@/modal', options.modal);

    vi.mock('expo-router', async () => {

        const activeOptions = routeRootModuleState.options;
        if (activeOptions.router) {
            return await activeOptions.router();
        }

        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');

        return createExpoRouterMock().module;
    });

    // Retain this existing translation boundary for the legacy route neighbors;
    // it is not an authority, storage, or feature-decision replacement.
    vi.mock('@/text', async () => {
        if (routeRootModuleState.options.text) return routeRootModuleState.options.text();
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: key => key });
    });


    vi.mock('react-native-unistyles', async () => {

        const activeOptions = routeRootModuleState.options;
        if (activeOptions.unistyles) {
            return await activeOptions.unistyles();
        }

        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');

        return createUnistylesMock();
    });

    vi.mock('react-native-safe-area-context', async (importOriginal) => {

        const actual = await importOriginal<typeof import('react-native-safe-area-context')>();

        const React = require('react');
        return {
            ...actual,
            initialWindowMetrics: {
                frame: { x: 0, y: 0, width: 0, height: 0 },
                insets: { top: 0, right: 0, bottom: 0, left: 0 },
            },
            SafeAreaProvider: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
            useSafeAreaInsets: () => ({
                top: 0,
                right: 0,
                bottom: 0,
                left: 0,
            }),
        };
    });

}
