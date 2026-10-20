import * as React from 'react';
import { BaseNavigationContainer, createNavigationContainerRef, createNavigatorFactory, StackRouter, useNavigationBuilder } from '@react-navigation/core';
import { afterEach, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { loadInstalledExpoPathSerializer, loadInstalledExpoRoutingState } from '@/dev/testkit/runtime/installedExpoPathSerializer';

// These are real installed navigators. A lazy app layout has no child getState
// listener during boot, exactly when the live export discarded its parsed leaf.
function LazyLayoutNavigator(props: Readonly<{ children: React.ReactNode }>) {
    const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children: props.children });
    return <NavigationContent>{descriptors[state.routes[state.index].key].render()}</NavigationContent>;
}
const Root = createNavigatorFactory(LazyLayoutNavigator)();
const PendingLayout = () => null;

afterEach(standardCleanup);

it('qualifies a cold Session through its mounted parent while the leaf navigator is still pending', async () => {
    const routing = await loadInstalledExpoRoutingState();
    const params = { id: 'session-a', serverId: 'home-a' };
    const router = StackRouter({});
    const options = { routeNames: ['index', 'session/[id]'], routeParamList: {}, routeGetIdList: {} };
    const current = router.getRehydratedState({ stale: true, routes: [{ name: 'session/[id]', params: { id: 'session-a' },
        state: { stale: true, routes: [{ name: 'index', params: { id: 'session-a' } }] },
    }] }, options);
    const action = { routes: [{ name: 'session/[id]', params,
        state: { routes: [{ name: 'index', params }] },
    }] };
    const selected = routing.findDivergentState(action, current);
    expect(selected.navigationState.key).toBe(current.key);
    const payload = routing.getPayloadFromStateRoute(selected.actionStateRoute);
    const replaced = router.getStateForAction(current, { type: 'REPLACE', target: selected.navigationState.key,
        payload: { name: payload.screen, params: payload.params },
    }, options);
    if (!replaced || typeof replaced.index !== 'number') throw new Error('Installed StackRouter rejected the Session replacement');
    expect(replaced.routes[replaced.index].name).toBe('session/[id]');
    expect(replaced.routes[replaced.index].params).toMatchObject(params);
});

it('still targets the admitted Session navigator when its child is mounted', async () => {
    const routing = await loadInstalledExpoRoutingState();
    const params = { id: 'session-a', serverId: 'home-a' };
    const child = { key: 'session-stack', type: 'stack', stale: false, index: 0,
        routes: [{ name: 'index', params: { id: 'session-a' } }] };
    const current = { key: 'app-stack', type: 'stack', stale: false, index: 0,
        routes: [{ name: 'session/[id]', params: { id: 'session-a' }, state: child }] };
    const action = { routes: [{ name: 'session/[id]', params,
        state: { routes: [{ name: 'index', params }] } }] };
    const selected = routing.findDivergentState(action, current);
    expect(selected.navigationState).toBe(child);
    expect(routing.getPayloadFromStateRoute(selected.actionStateRoute)).toEqual({ screen: 'index', params });
});

it.each([
    ['session/[id]', '/session/session-a/info?serverId=home-a', { id: 'session-a' }, {
        routes: [{ name: 'info', params: { id: 'session-a', serverId: 'home-a' } }],
    }],
    ['machine/[id]/index', '/machine/machine-a?serverId=home-a', { id: 'machine-a', serverId: 'home-a' }, undefined],
    ['machine/[id]/installables', '/machine/machine-a/installables?serverId=home-a', { id: 'machine-a', serverId: 'home-a' }, undefined],
] satisfies ReadonlyArray<readonly [string, string, { id: string; serverId?: string }, { routes: { name: string; params: { id: string; serverId: string } }[] } | undefined]>)('preserves the cold parsed %s leaf and Home before its lazy navigator registers', async (name, href, params, state) => {
    const navigation = createNavigationContainerRef();
    const serializer = await loadInstalledExpoPathSerializer();
    const getPathFromState = serializer.getPathFromState;
    if (typeof getPathFromState !== 'function') throw new Error('Installed Expo path serializer unavailable');
    await renderScreen(<BaseNavigationContainer ref={navigation} initialState={{ routes: [{
        name: 'App', params: { id: params.id }, state: { routes: [{ name, params, ...(state ? { state } : {}), path: href }] },
    }] }}>
        <Root.Navigator><Root.Screen name="App" component={PendingLayout} /></Root.Navigator>
    </BaseNavigationContainer>);
    const projected = getPathFromState(navigation.getRootState(), { screens: { App: { path: '', screens: {
        'session/[id]': { path: 'session/:id', screens: { info: 'info' } },
        'machine/[id]/index': 'machine/:id',
        'machine/[id]/installables': 'machine/:id/installables',
    } } } });
    expect(projected).toBe(href);
});
