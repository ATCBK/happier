import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

const route = vi.hoisted(() => ({ params: {} as Record<string, string>, replace: vi.fn() }));
const viewport = vi.hoisted(() => ({ width: 1440, listeners: new Set<() => void>() }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => '/session/resize-session', params: () => route.params,
    router: { replace: (href: unknown) => route.replace(href) },
}).module);
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    useWindowDimensions: () => ({ width: React.useSyncExternalStore(
        listener => { viewport.listeners.add(listener); return () => viewport.listeners.delete(listener); },
        () => viewport.width,
    ), height: 844, scale: 1, fontScale: 1 }),
    Dimensions: { get: () => ({ width: viewport.width, height: 844, scale: 1, fontScale: 1 }) },
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const runtime = installSessionPaneRuntimeTestHarness({ sessionId: 'resize-session', request: async (url) => (
    new URL(String(url)).pathname === '/v1/kv/bulk' ? Response.json({ values: [] }) : null
) });
const { storage } = await import('@/sync/domains/state/storageStore');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { useWindowDimensions } = await import('react-native');
const { MainAppTabStateProvider } = await import('./MainAppTabStateProvider');
const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
const { SessionCockpitChromeRegistryProvider, useSessionCockpitChromeRegister } = await import(
    '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'
);
const { resolveSessionMobileSurfaceIntent } = await import('@/components/workspaceCockpit/session/sessionCockpitState');
const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
const { applySessionPaneUrlState, buildActiveDetailsRouteParams, parseSessionPaneUrlState } = await import(
    '@/components/sessions/panes/url/sessionPaneUrlState'
);
const stayOnSurface = () => {};

function CockpitSelection() {
    const pane = useAppPaneScope('session:resize-session');
    const register = useSessionCockpitChromeRegister();
    const { width } = useWindowDimensions();
    const activeSurface = width > 390 ? 'chat' : resolveSessionMobileSurfaceIntent({
        routeKind: 'index', detailsTargetPresent: pane.scopeState?.details.isOpen,
    });
    React.useEffect(() => register({ sessionId: 'resize-session', serverId: runtime.serverId,
        activeSurface, terminalTabAvailable: false, openDetailsTabCount: pane.scopeState?.details.tabs.length ?? 0,
        switchSurface: stayOnSurface,
    }), [activeSurface, pane.scopeState?.details.tabs.length, register]);
    return null;
}

it('carries an open comparison through pane selection, cockpit registration and the phone route consumer', async () => {
    storage.setState(state => ({ settings: { ...state.settings, mobileWorkspaceExperienceV1: 'cockpit' } }));
    const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree', comparisonId: 'pending' }, view: 'walkthrough' });
    route.params = { ...buildActiveDetailsRouteParams([tab], tab.key), serverId: runtime.serverId };
    const expected = parseSessionPaneUrlState(route.params);
    const screen = await renderScreen(<runtime.Wrapper><MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <CockpitSelection /><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider></runtime.Wrapper>);
    await act(async () => applySessionPaneUrlState(runtime.pane, expected));
    await act(async () => { viewport.width = 390; for (const listener of viewport.listeners) listener(); });
    const url = new URL(String(route.replace.mock.calls.at(-1)?.[0]), 'https://happier.test');
    expect(url.pathname).toBe('/session/resize-session/details');
    expect(url.searchParams.get('serverId')).toBe(runtime.serverId);
    expect(parseSessionPaneUrlState(Object.fromEntries(url.searchParams))).toEqual(expected);
    await screen.unmount();
});
