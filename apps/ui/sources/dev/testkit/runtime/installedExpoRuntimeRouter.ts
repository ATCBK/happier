import { createRequire } from 'node:module';
import type { HrefObject } from 'expo-router';
import type { NavigationOptions } from 'expo-router/build/global-state/routing';
import { evaluateInstalledExpoModule as evaluate } from './installedExpoPathSerializer';

/** Exact SDK runtime inputs, independent of the generated route-membership constraint. */
type RuntimeHref = string | HrefObject;
type RuntimeNavigation = (href: RuntimeHref, options?: NavigationOptions) => void;
type RoutingState = Readonly<{
    key: string;
    type: string;
    index: number;
    routes: readonly Readonly<{ name: string; params?: object; state?: RoutingState }>[];
}>;

/** Run the installed SDK, substituting only its platform/navigation-container ports. */
export async function loadInstalledExpoRuntimeRouter(options: Readonly<{
    state: RoutingState;
    config: object;
    routeInfo?: Readonly<{ segments: readonly string[]; params: Readonly<Record<string, string>> }>;
    ready?: boolean;
}>) {
    const require = createRequire(import.meta.url);
    const validator = await evaluate(require.resolve('@react-navigation/core').replace(/index\.js$/, 'validatePathConfig.js'), {});
    const parser = await evaluate(require.resolve('expo-router/build/fork/getStateFromPath'), {
        '@react-navigation/native': validator,
    });
    const parsePath = parser.getStateFromPath;
    if (typeof parsePath !== 'function') throw new Error('Installed Expo path parser unavailable');
    const openedUrls: string[] = [];
    const linkingPort = { openURL: (url: string) => { openedUrls.push(url); } };
    const redirects = await evaluate(require.resolve('expo-router/build/getRoutesRedirects'), { 'expo-linking': linkingPort });
    const actions: unknown[] = [];
    const resolvedPaths: string[] = [];
    let backCount = 0;
    const navigation = {
        getRootState: () => options.state,
        dispatch: (action: unknown) => { actions.push(action); },
        goBack: () => { backCount += 1; },
    };
    const ref = { current: navigation, isReady: () => options.ready !== false };
    const exports = await evaluate(require.resolve('expo-router/build/global-state/routing'), {
        'expo/dom': { IS_DOM: false },
        'expo-linking': linkingPort,
        'react-native': { Platform: { OS: 'ios' } },
        '../getRoutesRedirects': redirects,
        './router-store': { store: {
            navigationRef: ref,
            redirects: [],
            getRouteInfo: () => options.routeInfo ?? { segments: [], params: {} },
            linking: {
                config: options.config,
                getStateFromPath: (href: string, config: object) => {
                    resolvedPaths.push(href);
                    return parsePath(href, config);
                },
            },
        } },
    });
    // The published CommonJS evaluator is an untyped external fixture boundary.
    const sdk = exports as Readonly<{
        push: RuntimeNavigation;
        replace: RuntimeNavigation;
        navigate: RuntimeNavigation;
        routingQueue: { run(ref: { current: typeof navigation }): void };
    }>;
    return {
        router: { push: sdk.push, replace: sdk.replace, navigate: sdk.navigate },
        flush: () => sdk.routingQueue.run(ref),
        actions,
        resolvedPaths,
        openedUrls,
        get backCount() { return backCount; },
    };
}
