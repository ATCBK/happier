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
const { SessionCockpitTabBar } = await import('./bars/SessionCockpitTabBar');
const { SessionCockpitChromeRegistryProvider, useSessionCockpitChromeRegister } = await import(
    '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry'
);
const { resolveSessionMobileSurfaceIntent } = await import('@/components/workspaceCockpit/session/sessionCockpitState');
const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
const { applySessionPaneUrlState, buildActiveDetailsRouteParams, parseSessionPaneUrlState } = await import(
    '@/components/sessions/panes/url/sessionPaneUrlState'
);
const { useSessionPaneUrlSync } = await import('@/components/sessions/panes/url/useSessionPaneUrlSync');
const stayOnSurface = () => {};

function PaneRouteSelection(props: Readonly<{ params: Record<string, string> }>) {
    const pane = useAppPaneScope('session:resize-session');
    const urlState = React.useMemo(() => parseSessionPaneUrlState(props.params), [props.params]);
    useSessionPaneUrlSync({ enabled: true, browserMirrorsEnabled: false, scopeKey: 'session:resize-session',
        pane, scopeState: pane.scopeState, urlState, setParams: null });
    return null;
}

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
    if (!expected) throw new Error('Expected a canonical comparison pane URL');
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

it.each([
    { pane: 'right', explicitChat: false },
    { pane: 'bottom', explicitChat: false },
    { pane: 'bottom', explicitChat: true },
])('returns from a resized $pane-terminal route to Chat through the registered cockpit tab (explicit Chat: $explicitChat)', async ({ pane, explicitChat }) => {
    viewport.width = 390;
    route.replace.mockClear();
    route.params = { serverId: runtime.serverId, [pane]: 'terminal', ...(explicitChat ? { mobileSurface: 'chat' } : {}) };
    storage.setState(state => ({ settings: { ...state.settings, mobileWorkspaceExperienceV1: 'cockpit' } }));
    function TerminalSelection() {
        const register = useSessionCockpitChromeRegister();
        const [surface, switchSurface] = React.useState<'chat' | 'terminal'>(explicitChat ? 'chat' : 'terminal');
        React.useEffect(() => register({ sessionId: 'resize-session', serverId: runtime.serverId,
            activeSurface: surface, terminalTabAvailable: true, openDetailsTabCount: 0,
            switchSurface: next => switchSurface(next === 'terminal' ? 'terminal' : 'chat'),
        }), [register, surface]);
        return null;
    }
    const scene = () => <runtime.Wrapper><MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <PaneRouteSelection params={route.params} /><TerminalSelection /><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider></runtime.Wrapper>;
    const screen = await renderScreen(scene());
    expect(pane === 'bottom' ? runtime.pane.scopeState?.bottom.isOpen : runtime.pane.scopeState?.right.isOpen).toBe(true);
    await act(async () => screen.findByType(SessionCockpitTabBar).props.onSurfacePress('chat'));
    const url = new URL(String(route.replace.mock.calls.at(-1)?.[0]), 'https://happier.test');
    expect(url.pathname).toBe('/session/resize-session');
    expect(url.searchParams.get('serverId')).toBe(runtime.serverId);
    expect(url.searchParams.get('mobileSurface')).toBe('chat');
    expect(parseSessionPaneUrlState(Object.fromEntries(url.searchParams))).toBeNull();
    route.params = Object.fromEntries(url.searchParams);
    await act(async () => screen.update(scene()));
    expect(runtime.pane.scopeState?.bottom.isOpen).toBe(false);
    expect(runtime.pane.scopeState?.right.isOpen).toBe(false);
    await screen.unmount();
});
