import { describe, expect, it } from 'vitest';

import { initializeRootLayoutRuntimeForTests, renderRootLayoutRoute, installRootLayoutRouteCommonModuleMocks } from './rootLayoutRouteTestHelpers';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installRootLayoutRouteCommonModuleMocks();

await initializeRootLayoutRuntimeForTests();

/** The current top-level automation destinations share the root title owner. */
describe('RootLayout automation route titles', () => {
    it.each([
        'automations/index',
        'automations/[id]',
        'automations/new',
        'automations/edit',
        'automations/settings',
    ])('declares a central header title for %s', async (routeName) => {
        const RootLayout = (await import('@/app/(app)/_layout')).default;
        const screen = await renderRootLayoutRoute(RootLayout);

        const stackScreen = screen.tree.root
            .findAllByType('StackScreen' as never)
            .find((node) => (node.props as { name?: string }).name === routeName);
        expect(stackScreen, `Missing central Stack.Screen for ${routeName}`).toBeDefined();

        const rawOptions = (stackScreen!.props as { options?: unknown }).options;
        const options = (typeof rawOptions === 'function'
            ? (rawOptions as (params: Record<string, unknown>) => Record<string, unknown>)({ navigation: {} })
            : rawOptions ?? {}) as Record<string, unknown>;
        expect(typeof options.headerTitle === 'string' && options.headerTitle.length > 0).toBe(true);
    });
});
