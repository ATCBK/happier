import * as React from 'react';
import { BaseNavigationContainer, createNavigatorFactory, StackRouter, useNavigationBuilder, useRoute } from '@react-navigation/core';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionRouteHomesFixture, installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

const routeRuntime = vi.hoisted(() => ({ pathname: '/session/session-unloaded', replace: vi.fn() }));

// Expo's route context contains only this layout's params. Its parsed search
// params live on the child route; use the real installed navigator underneath.
installSessionRouteCommonModuleMocks({ text: async () => vi.importActual('@/text'), modal: async () => vi.importActual('@/modal'), nativeNavigation: async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    const core = await vi.importActual<typeof import('@react-navigation/core')>('@react-navigation/core');
    return { ...createReactNavigationNativeMock(), useRoute: core.useRoute, useNavigationState: core.useNavigationState };
}, router: async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const boundary = createExpoRouterMock();
    return { ...boundary.module, useLocalSearchParams: () => useRoute().params ?? {},
        usePathname: () => routeRuntime.pathname,
        useRouter: () => ({ replace: routeRuntime.replace }),
        Slot: () => React.createElement('SessionChild') };
} });

function Navigator(props: Readonly<{ children: React.ReactNode }>) {
    const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children: props.children });
    return <NavigationContent>{state.routes.map(route => <React.Fragment key={route.key}>{descriptors[route.key].render()}</React.Fragment>)}</NavigationContent>;
}
const Root = createNavigatorFactory(Navigator)();
const Layout = (await import('@/app/(app)/session/[id]/_layout')).default;
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const homesFixture = createSessionRouteHomesFixture();
afterEach(() => { standardCleanup(); homesFixture.restore(); routeRuntime.replace.mockClear(); });

it('admits a cold Home-qualified Session leaf when the Home is on its parsed child, not the layout', async () => {
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}><BaseNavigationContainer initialState={{ routes: [{
        name: 'Session', params: { id: 'session-unloaded' }, state: { routes: [{
            name: 'follow', params: { id: 'session-unloaded', serverId: 'home-b' },
        }] },
    }] }}><Root.Navigator><Root.Screen name="Session" component={Layout} /></Root.Navigator></BaseNavigationContainer></InjectedAuthProvider>);
    expect(screen.findAllByType('SessionChild')).toHaveLength(1);
});

it('does not use the focused sibling Home to admit a retained bare Session', async () => {
    homesFixture.seed(['home-a', 'home-b']);
    const screen = await renderScreen(<InjectedAuthProvider credentials={null}><BaseNavigationContainer initialState={{ index: 1, routes: [
        { name: 'Bare', params: { id: 'session-bare' } },
        { name: 'Qualified', params: { id: 'session-qualified' }, state: { routes: [{
            name: 'info', params: { id: 'session-qualified', serverId: 'home-b' },
        }] } },
    ] }}><Root.Navigator><Root.Screen name="Bare" component={Layout} /><Root.Screen name="Qualified" component={Layout} /></Root.Navigator></BaseNavigationContainer></InjectedAuthProvider>);
    expect(screen.findAllByType('SessionChild')).toHaveLength(1);
    expect(screen.findAllByTestId('session-home-chooser')).toHaveLength(1);
});

it('keeps the cold parsed child file target when its sole Home qualifies the route', async () => {
    homesFixture.seed(['home-b']);
    routeRuntime.pathname = '/session/session-unloaded/file';
    await renderScreen(<InjectedAuthProvider credentials={null}><BaseNavigationContainer initialState={{ routes: [{
        name: 'Session', params: { id: 'session-unloaded' }, state: { routes: [{
            name: 'file', params: { id: 'session-unloaded', path: 'src/a.ts', startLine: '7' },
        }] },
    }] }}><Root.Navigator><Root.Screen name="Session" component={Layout} /></Root.Navigator></BaseNavigationContainer></InjectedAuthProvider>);
    expect(routeRuntime.replace).toHaveBeenCalledWith('/session/session-unloaded/file?serverId=home-b&path=src%2Fa.ts&startLine=7');
});
