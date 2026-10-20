import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, expect, it, onTestFinished, vi } from 'vitest';
import { resolveHref } from 'expo-router/build/link/href';
import { flushHookEffects, invokeTestInstanceHandler, standardCleanup } from '@/dev/testkit';
import {
    createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';

const route = vi.hoisted(() => ({ params: {} as Record<string, string>, replace: vi.fn(), back: vi.fn(), href: '/session/s1/details' }));
const routeListeners = new Set<() => void>();
let resetRouteParams = () => {};
function isRouteHref(value: unknown): value is Parameters<typeof resolveHref>[0] {
    return typeof value === 'string' || (typeof value === 'object' && value !== null
        && 'pathname' in value && typeof value.pathname === 'string');
}
const Focus = React.createContext(true);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installSessionFilesViewBoundaries();
vi.doMock('expo-router', async () => {
    const mock = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
        pathname: () => new URL(React.useSyncExternalStore(listener => {
            routeListeners.add(listener);
            return () => routeListeners.delete(listener);
        }, () => route.href), 'https://happier.test').pathname,
        params: () => route.params,
        router: {
            replace: (href: unknown) => {
                if (!isRouteHref(href)) throw new Error('Expected an Expo string or structured href');
                route.href = resolveHref(href);
                if (typeof window !== 'undefined' && new URL(route.href, window.location.href).href !== window.location.href) {
                    window.history.replaceState(window.history.state, '', route.href);
                }
                route.params = { id: 's1', ...Object.fromEntries(new URL(route.href, 'https://happier.test').searchParams) };
                // Replacing an Expo route replaces its params; setParams overlays
                // from the departing route must not survive in this boundary.
                resetRouteParams();
                route.replace(href);
                for (const listener of routeListeners) listener();
            },
            canGoBack: () => true,
            back: () => { route.href = '/'; route.back(); },
        },
    });
    resetRouteParams = () => { mock.resetParams(); };
    return mock.module;
});
vi.doMock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock(
    { platformOS: 'ios' }, { useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
        Dimensions: { get: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }) } },
));
vi.mock('@react-navigation/native', async () => ({
    ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
    useIsFocused: () => React.useContext(Focus),
}));
// Only the external navigator is replaced. Session scenes, comparison renderer,
// pane reducer, registration, route producer and URL consumer remain real.
vi.mock('@react-navigation/bottom-tabs', () => ({ createBottomTabNavigator: () => ({
    Screen: () => null,
    Navigator: ({ children, initialRouteName, tabBar }: React.PropsWithChildren<{
        initialRouteName: string;
        tabBar: (props: { state: { index: number; routes: Array<{ key: string; name: string }> };
            navigation: { navigate: (name: string) => void; emit: () => { defaultPrevented: boolean } } }) => React.ReactNode;
    }>) => {
        const screens = React.Children.toArray(children).filter(React.isValidElement<{ name: string;
            children: (input: { navigation: { navigate: (name: string) => void; canGoBack: () => boolean; goBack: () => void } }) => React.ReactNode }>);
        const [selected, select] = React.useState(initialRouteName);
        const routes = screens.map(screen => ({ name: screen.props.name, key: screen.props.name }));
        const navigation = { navigate: select, canGoBack: () => false, goBack: () => {}, emit: () => ({ defaultPrevented: false }) };
        return <>{screens.filter(screen => screen.props.name === selected).map(screen =>
            <Focus.Provider key={screen.props.name} value={true}>{screen.props.children({ navigation })}</Focus.Provider>)}
            {tabBar({ state: { routes, index: routes.findIndex(item => item.name === selected) }, navigation })}</>;
    },
}) }));

let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
// Compile the real Sync graph during collection, after transport installation;
// the hook deadline belongs to fixture preparation rather than cold compilation.
await loadSyncSingletonForTests();
await import('@/components/sessions/panes/SessionDetailsPanel');
await import('@/components/sessions/files/views/SessionScmReviewDetailsView');
await import('./SessionCockpitShell');
beforeAll(async () => {
    const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
    await prepareSessionDraftPersistenceStorage();
});
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); resetRouteParams(); });

it.each([true, false])('leaves phone Details through the real comparison Back with pane open=%s without deleting its retained tab', async (paneOpen) => {
    const snapshot = fileViewSnapshot({ rootPath: '/tmp/repo' });
    fixture = await createSessionFilesViewFixture({ serverUrl: `https://phone-pane-${paneOpen}.test`, rootPath: '/tmp/repo', rpc: request =>
        request.method === 'scm.status.snapshot' ? { success: true, snapshot } : undefined,
        request: async url => new URL(String(url)).pathname === '/v1/kv/bulk'
            ? Response.json({ values: [] }) : Response.json({}, { status: 404 }),
    });
    fixture.setSnapshot(snapshot);
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
    const { buildActiveDetailsRouteParams, parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { SessionCockpitShell } = await import('./SessionCockpitShell');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
    route.params = { ...buildActiveDetailsRouteParams([tab], tab.key), serverId: fixture.home.id };
    route.href = '/session/s1/details';
    let pane!: ReturnType<typeof useAppPaneScope>;
    function Probe() { pane = useAppPaneScope('session:s1'); return null; }
    const screen = await fixture.render(<MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <Probe /><SessionCockpitShell sessionId="s1" scopeId="session:s1" surface="tabs" routeServerId={fixture.home.id}
            terminalTabAvailable={false} /><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>);
    const measure = async () => act(async () => {
        // Node supplies no native layout events. Deliver the real platform event
        // to each mounted host; the pane and comparison layout owners stay real.
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    await measure();
    await act(async () => pane.openDetailsTab(tab, { intent: 'pinned' }));
    if (!paneOpen) await act(async () => pane.closeDetails());
    await flushHookEffects({ cycles: 20 });
    await measure();
    await flushHookEffects({ cycles: 20 });
    expect(screen.findHostByTestId('scm-comparison-phone-back')).not.toBeNull();
    route.replace.mockClear();
    await screen.pressByTestIdAsync('scm-comparison-phone-back');
    await flushHookEffects({ cycles: 20 });
    const url = new URL(String(route.replace.mock.calls.at(-1)?.[0]), 'https://happier.test');
    expect(url.pathname).toBe('/session/s1');
    expect(url.searchParams.get('serverId')).toBe(fixture.home.id);
    expect(parseSessionPaneUrlState(Object.fromEntries(url.searchParams))?.details).toBeUndefined();
    expect(pane.scopeState?.details.isOpen).toBe(false);
    expect(pane.scopeState?.details.tabs.map(item => item.key)).toEqual([tab.key]);
    await screen.unmount();
});

it.each([false, true])('opens phone Details through workspace navigation and returns to the conversation with Watch=%s', async (watch) => {
    const snapshot = fileViewSnapshot({ rootPath: '/tmp/repo', entries: [{
        path: 'alpha.txt', kind: 'modified', includeStatus: 'unmodified', pendingStatus: 'modified',
        hasIncludedDelta: false, hasPendingDelta: true, previousPath: null,
        stats: { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false },
    }] });
    fixture = await createSessionFilesViewFixture({ serverUrl: 'https://phone-git.test', rootPath: '/tmp/repo', rpc: request =>
        request.method === 'scm.status.snapshot' ? { success: true, snapshot } : undefined,
        request: async url => new URL(String(url)).pathname === '/v1/kv/bulk'
            ? Response.json({ values: [] }) : Response.json({}, { status: 404 }),
    });
    fixture.setSnapshot(snapshot);
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    fixture.storage.setState({ isDataReady: true, localSettings: {
        ...fixture.storage.getState().localSettings, workspaceLayoutV1: {},
    } });
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
    const { SessionDestinationBody } = await import('@/components/sessions/shell/SessionDestinationBody');
    const { SessionDetailsDestinationBody } = await import('@/components/sessions/shell/SessionDetailsDestinationBody');
    const { WorkspaceDestinationBody } = await import('@/components/appShell/workspace/WorkspaceDestinationBody');
    const { readSessionPresentationAdapterAtAddress } = await import('@/components/sessions/presentation/sessionComposerPresentationTargets');
    const { SessionViewerSourceAccountScopeProvider } = await import('@/components/sessions/viewer/SessionViewerSourceAccountScope');
    const { SessionCockpitShell } = await import('./SessionCockpitShell');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
    const { hrefForDestinationRef, resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const { parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
    const { buildActiveDetailsRouteParams } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    route.params = { id: 's1', serverId: fixture.home.id, mobileSurface: watch ? 'chat' : 'git' };
    if (!watch) route.params.right = 'git';
    route.href = `/session/s1?${new URLSearchParams(route.params)}`;
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    let workspace!: WorkspaceNavigationContextValue;
    let pane!: ReturnType<typeof useAppPaneScope>;
    let instanceKey = '';
    let observingReturn = false;
    const returnedRightPresentations: boolean[] = [];
    function Probe() {
        pane = useAppPaneScope(createSessionPaneScopeId('s1', fixture.home.id, instanceKey));
        if (observingReturn && selectedTab().target.kind === 'session') {
            returnedRightPresentations.push(pane.scopeState?.right.isOpen === true);
        }
        return null;
    }
    const selectedTab = () => workspace.state.tabs[workspace.state.groups[workspace.state.focusedGroupId].activeTabId];
    const screen = await fixture.render(<MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <WorkspaceProvider enabled catalog={catalog}>{navigation => {
            workspace = navigation;
            const selected = selectedTab();
            instanceKey = selected.id;
            const href = hrefForDestinationRef(catalog, selected.target);
            if (!href) throw new Error('The production workspace target must have a route');
            return <DestinationInstanceHost tabId={selected.id} ref={selected.target}
                pathname={new URL(href, 'https://happier.test').pathname} focused visible phone
                navigation={navigation.navigationForTab(selected.id)}>
                <Probe /><WorkspaceDestinationBody target={selected.target} pathname={new URL(href, 'https://happier.test').pathname}
                    renderSession={() => <SessionDestinationBody />} renderSessionDetails={() => <SessionDetailsDestinationBody />} />
            </DestinationInstanceHost>;
        }}</WorkspaceProvider><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>);
    const measure = async () => act(async () => {
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    await measure();
    await flushHookEffects({ cycles: 20 });
    const sourceLifetime = watch ? screen.findAllByType(SessionViewerSourceAccountScopeProvider)
        .map(provider => provider.props.accountLifetime).find(lifetime => lifetime?.isCurrent()) : null;
    if (watch) {
        expect(sourceLifetime?.isCurrent()).toBe(true);
        // Phone Watch uses this real registered adapter; the header opener is desktop-only.
        await act(async () => expect(readSessionPresentationAdapterAtAddress({ serverId: fixture.home.id, sessionId: 's1' })
            ?.apply({ kind: 'viewer.open', source: 'computer' })).toEqual({ status: 'applied' }));
        expect(screen.findHostByTestId('session-viewer-sticky')).not.toBeNull();
        const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
        await act(async () => expect(workspace.openHref(`/session/s1/details?${new URLSearchParams({
            serverId: fixture.home.id, ...buildActiveDetailsRouteParams([tab], tab.key),
        })}`)).toBe(true));
    } else {
        expect(screen.tree.findAllByType(SessionCockpitShell).map(node => node.props.surface)).toEqual(['git']);
        await vi.waitFor(async () => {
            await measure();
            expect(screen.findHostByTestId('session-rightpanel-git-walkthrough')).not.toBeNull();
        });
        await screen.pressByTestIdAsync('session-rightpanel-git-walkthrough');
    }
    await flushHookEffects({ cycles: 20 });
    await measure();
    await flushHookEffects({ cycles: 20 });
    const detailsUrl = new URL(route.href, 'https://happier.test');
    expect(detailsUrl.pathname).toBe('/session/s1/details');
    expect(detailsUrl.searchParams.get('serverId')).toBe(fixture.home.id);
    expect(parseSessionPaneUrlState(Object.fromEntries(detailsUrl.searchParams))?.details).toMatchObject({
        kind: 'scmReview', comparison: { kind: 'workingTree' }, view: 'walkthrough',
    });
    expect(selectedTab().target).toMatchObject({ kind: 'sessionDetails', params: {
        details: 'scmReview', comparison: 'workingTree', view: 'walkthrough',
    } });
    expect(screen.findHostByTestId('scm-comparison-phone-back')).not.toBeNull();
    if (watch) expect(sourceLifetime?.isCurrent()).toBe(true);
    observingReturn = true;
    await screen.pressByTestIdAsync('scm-comparison-phone-back');
    await flushHookEffects({ cycles: 20 });
    await measure();
    await flushHookEffects({ cycles: 20 });
    expect(selectedTab().target).toMatchObject({ kind: 'session', params: { mobileSurface: 'chat' } });
    expect(screen.findHostByTestId('agent-input-composer')).not.toBeNull();
    expect(screen.findHostByTestId('session-cockpit-scene:chat')).not.toBeNull();
    expect(screen.findHostByTestId('session-cockpit-scene:git')).toBeNull();
    expect(screen.findHostByTestId('session-viewer-sticky') !== null).toBe(watch);
    if (watch) expect(screen.findAllByType(SessionViewerSourceAccountScopeProvider)
        .some(provider => provider.props.accountLifetime === sourceLifetime)).toBe(true);
    expect(pane.scopeState?.right.isOpen).toBe(false);
    // The returned destination must never receive an open Git presentation:
    // web's pane URL writer can publish that first snapshot before Chat effects.
    expect(returnedRightPresentations.length).toBeGreaterThan(0);
    expect(returnedRightPresentations).not.toContain(true);
    // The Git opener retains a pane tab; direct Details selection is URL-owned.
    if (!watch) expect(pane.scopeState?.details.tabs[0]?.resource).toMatchObject({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
    await screen.unmount();
    if (watch) expect(sourceLifetime?.isCurrent()).toBe(false);
});

it.each(['classic', 'cockpit', 'hosted'] as const)('returns from the full %s phone Details route to its qualified Session when history leads Home', async (experience) => {
    const snapshot = fileViewSnapshot({ rootPath: '/tmp/repo' });
    fixture = await createSessionFilesViewFixture({ serverUrl: `https://phone-${experience}.test`, rootPath: '/tmp/repo', rpc: request =>
        request.method === 'scm.status.snapshot' ? { success: true, snapshot } : undefined,
        request: async url => new URL(String(url)).pathname === '/v1/kv/bulk'
            ? Response.json({ values: [] }) : Response.json({}, { status: 404 }),
    });
    fixture.setSnapshot(snapshot);
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: experience === 'classic' ? 'classic' : 'cockpit' });
    // Admit a hydrated, fresh workspace in the real store; preceding route
    // cases share this Home but must not lend this provider an old layout.
    fixture.storage.setState({ isDataReady: true, localSettings: {
        ...fixture.storage.getState().localSettings, workspaceLayoutV1: {},
    } });
    const { createSessionScmReviewDetailsTab } = await import('@/components/sessions/panes/details/sessionDetailsTabBuilders');
    const { buildActiveDetailsRouteParams, parseSessionPaneUrlState } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { SessionDetailsDestinationBody } = await import('@/components/sessions/shell/SessionDetailsDestinationBody');
    const { usePersistSessionLastMobileSurface } = await import('@/sync/domains/state/storage');
    const { SessionDestinationBody } = await import('@/components/sessions/shell/SessionDestinationBody');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
    const { hrefForDestinationRef, resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const tab = createSessionScmReviewDetailsTab({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
    route.params = { ...buildActiveDetailsRouteParams([tab], tab.key), id: 's1', serverId: fixture.home.id };
    route.href = '/session/s1/details';
    let instanceKey: string | null = null;
    let workspace!: WorkspaceNavigationContextValue;
    let pane!: ReturnType<typeof useAppPaneScope>;
    let persistSurface!: ReturnType<typeof usePersistSessionLastMobileSurface>;
    function Probe() {
        pane = useAppPaneScope(createSessionPaneScopeId('s1', fixture.home.id, instanceKey));
        persistSurface = usePersistSessionLastMobileSurface();
        return null;
    }
    const body = <><Probe /><SessionDetailsDestinationBody /></>;
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    const selectedWorkspaceTab = () => workspace.state.tabs[workspace.state.groups[workspace.state.focusedGroupId].activeTabId];
    const detailsHref = `/session/s1/details?${new URLSearchParams(route.params)}`;
    const screen = await fixture.render(<MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        {experience === 'hosted' ? <WorkspaceProvider enabled catalog={catalog}>{navigation => {
            workspace = navigation;
            const selected = selectedWorkspaceTab();
            instanceKey = selected.id;
            const href = hrefForDestinationRef(catalog, selected.target);
            if (!href) throw new Error('The production workspace target must have a route');
            return <DestinationInstanceHost tabId={selected.id} ref={selected.target} pathname={new URL(href, 'https://happier.test').pathname}
                focused visible phone navigation={navigation.navigationForTab(selected.id)}>
                <Probe />{selected.target.kind === 'sessionDetails' ? <SessionDetailsDestinationBody /> : <SessionDestinationBody />}
            </DestinationInstanceHost>;
        }}</WorkspaceProvider> : body}<MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>);
    const originalInstanceKey = instanceKey;
    if (instanceKey) await act(async () => {
        pane.openDetailsTab(tab, { intent: 'pinned' });
        pane.openRight({ tabId: 'git' });
    });
    await flushHookEffects({ cycles: 20 });
    const measure = async () => act(async () => {
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    await measure();
    await flushHookEffects({ cycles: 20 });
    expect(screen.findHostByTestId('scm-comparison-phone-back')).not.toBeNull();
    expect(pane.scopeState?.details.tabs[0]?.resource).toMatchObject({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
    await act(async () => persistSurface('s1', 'tabs', fixture.home.id));
    route.replace.mockClear();
    route.back.mockClear();
    await screen.pressByTestIdAsync('scm-comparison-phone-back');
    await flushHookEffects({ cycles: 20 });
    const url = new URL(route.href, 'https://happier.test');
    expect(url.pathname).toBe('/session/s1');
    expect(url.searchParams.get('serverId')).toBe(fixture.home.id);
    expect(parseSessionPaneUrlState(Object.fromEntries(url.searchParams))?.details).toBeUndefined();
    expect(url.searchParams.get('mobileSurface')).toBe('chat');
    if (experience === 'hosted') {
        expect(selectedWorkspaceTab()).toMatchObject({ id: originalInstanceKey, target: { kind: 'session', params: { id: 's1', serverId: fixture.home.id } } });
        expect(screen.tree.findAllByType(SessionDetailsDestinationBody)).toHaveLength(0);
        expect(screen.tree.findAllByType(SessionDestinationBody)).toHaveLength(1);
        expect(screen.findHostByTestId('agent-input-composer')).not.toBeNull();
        expect(screen.findHostByTestId('session-cockpit-scene:chat')).not.toBeNull();
        expect(screen.findHostByTestId('session-cockpit-scene:git')).toBeNull();
        expect(pane.scopeState?.right.isOpen).toBe(false);
        await act(async () => { expect(workspace.openHref(detailsHref, { tabId: originalInstanceKey! })).toBe(true); });
        await flushHookEffects({ cycles: 20 });
        await measure();
        await flushHookEffects({ cycles: 20 });
        expect(selectedWorkspaceTab()).toMatchObject({ id: originalInstanceKey, target: { kind: 'sessionDetails' } });
        expect(screen.findHostByTestId('scm-comparison-phone-back')).not.toBeNull();
    }
    // Hosted Details uses its destination selection; its retained pane remains
    // available when the workspace switches back to the Session destination.
    expect(pane.scopeState?.details.isOpen).toBe(false);
    expect(pane.scopeState?.details.tabs[0]?.resource).toMatchObject({ comparison: { kind: 'workingTree' }, view: 'walkthrough' });
    await screen.unmount();
});

it('presents a Computer window tab on the phone Details surface through the Session viewer source authority', async () => {
    fixture = await createSessionFilesViewFixture({ serverUrl: 'https://phone-computer-tab.test', rootPath: '/tmp/repo', rpc: () => undefined,
        request: async url => new URL(String(url)).pathname === '/v1/kv/bulk'
            ? Response.json({ values: [] }) : Response.json({}, { status: 404 }),
    });
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    const { createComputerScreenDetailsTab } = await import('@/components/computer/computerScreenDetailsTab');
    const { buildActiveDetailsRouteParams } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { createRetainedPresentationSlotsStore, RetainedPresentationSlotsProvider } = await import('@/components/ui/presentation/retainedPresentationSlots');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { SessionCockpitShell } = await import('./SessionCockpitShell');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    const tab = createComputerScreenDetailsTab({ machineId: 'machine-1', title: 'Computer' });
    route.params = { ...buildActiveDetailsRouteParams([tab], tab.key), serverId: fixture.home.id };
    route.href = '/session/s1/details';
    const slots = createRetainedPresentationSlotsStore();
    let pane!: ReturnType<typeof useAppPaneScope>;
    function Probe() { pane = useAppPaneScope('session:s1'); return null; }
    const screen = await fixture.render(<RetainedPresentationSlotsProvider store={slots}><MainAppTabStateProvider>
        <SessionCockpitChromeRegistryProvider><Probe />
            <SessionCockpitShell sessionId="s1" scopeId="session:s1" surface="tabs" routeServerId={fixture.home.id}
                terminalTabAvailable={false} /><MobileBottomChromeHost />
        </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider></RetainedPresentationSlotsProvider>);
    const measure = async () => act(async () => {
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    await measure();
    await act(async () => pane.openDetailsTab(tab, { intent: 'pinned' }));
    await flushHookEffects({ cycles: 20 });
    await measure();
    await flushHookEffects({ cycles: 20 });
    // The tab's body is the retained Computer source: without the Session's account authority the
    // surface binds nothing and the phone shows a blank page.
    expect(slots.getPortalSnapshot().some(entry => entry.slotId.endsWith(':viewer:computer') && entry.visible)).toBe(true);
    await screen.unmount();
});

it('selects Chat from a retained Computer Details destination without replacing its workspace identity', async () => {
    const { Platform } = await import('react-native');
    const platform = Platform.OS;
    Object.assign(Platform, { OS: 'web' });
    onTestFinished(() => { Object.assign(Platform, { OS: platform }); });
    fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: () => undefined,
        request: async url => new URL(String(url)).pathname === '/v1/kv/bulk'
            ? Response.json({ values: [] }) : Response.json({}, { status: 404 }),
    });
    fixture.storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
    fixture.storage.setState({ isDataReady: true, localSettings: {
        ...fixture.storage.getState().localSettings, workspaceLayoutV1: {},
    } });
    const { createComputerScreenDetailsTab } = await import('@/components/computer/computerScreenDetailsTab');
    const { buildActiveDetailsRouteParams } = await import('@/components/sessions/panes/url/sessionPaneUrlState');
    const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
    const { createSessionPaneScopeId } = await import('@/components/sessions/panes/sessionPaneScopeId');
    const { SessionDestinationBody } = await import('@/components/sessions/shell/SessionDestinationBody');
    const { SessionDetailsDestinationBody } = await import('@/components/sessions/shell/SessionDetailsDestinationBody');
    const { WorkspaceDestinationBody } = await import('@/components/appShell/workspace/WorkspaceDestinationBody');
    const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
    const { WorkspaceProvider } = await import('@/components/appShell/workspace/WorkspaceProvider');
    const { hrefForDestinationRef, resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
    const { SessionCockpitChromeRegistryProvider } = await import('./SessionCockpitChromeRegistry');
    const { MobileBottomChromeHost } = await import('@/components/navigation/mobile/chrome/MobileBottomChromeHost');
    const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
    route.params = { id: 's1', serverId: fixture.home.id, mobileSurface: 'chat' };
    route.href = `/session/s1?${new URLSearchParams(route.params)}`;
    const { installBrowserRuntimeForTests } = await import('@/dev/testkit/harness/browserRuntimeHarness');
    const browser = await installBrowserRuntimeForTests({ url: `https://route.test${route.href}` });
    onTestFinished(() => browser.restore());
    const catalog = resolveCompactAppDestinations({ pages: [], builtins: {
        externalSessions: false, inbox: false, workflows: false, friends: false,
    } });
    let workspace!: WorkspaceNavigationContextValue;
    let pane!: ReturnType<typeof useAppPaneScope>;
    let instanceKey = '';
    const selectedTab = () => workspace.state.tabs[workspace.state.groups[workspace.state.focusedGroupId].activeTabId];
    function Probe() {
        pane = useAppPaneScope(createSessionPaneScopeId('s1', fixture.home.id, instanceKey));
        return null;
    }
    const screen = await fixture.render(<MainAppTabStateProvider><SessionCockpitChromeRegistryProvider>
        <WorkspaceProvider enabled catalog={catalog}>{navigation => {
            workspace = navigation;
            const selected = selectedTab();
            instanceKey = selected.id;
            const href = hrefForDestinationRef(catalog, selected.target)!;
            const pathname = new URL(href, 'https://route.test').pathname;
            return <DestinationInstanceHost tabId={selected.id} ref={selected.target} pathname={pathname} focused visible phone
                navigation={navigation.navigationForTab(selected.id)}>
                <Probe /><WorkspaceDestinationBody target={selected.target} pathname={pathname}
                    renderSession={() => <SessionDestinationBody />} renderSessionDetails={() => <SessionDetailsDestinationBody />} />
            </DestinationInstanceHost>;
        }}</WorkspaceProvider><MobileBottomChromeHost />
    </SessionCockpitChromeRegistryProvider></MainAppTabStateProvider>);
    const measure = async () => act(async () => {
        for (const host of screen.tree.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function')) {
            invokeTestInstanceHandler(host, 'onLayout', { nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } });
        }
    });
    try {
        await measure();
        await flushHookEffects({ cycles: 20 });
        const originalId = selectedTab().id;
        const tab = createComputerScreenDetailsTab({ machineId: 'machine-1', title: 'Computer' });
        await act(async () => {
            pane.openDetailsTab(tab, { intent: 'pinned' });
            const navigation = workspace.navigationForTab(originalId);
            if (!navigation.setParams) throw new Error('Expected workspace navigation to support route params');
            navigation.setParams(buildActiveDetailsRouteParams([tab], tab.key));
        });
        await act(async () => { workspace.openHref(`/session/s1/details?${new URLSearchParams({
            serverId: fixture.home.id, ...buildActiveDetailsRouteParams([tab], tab.key),
        })}`, { tabId: originalId }); });
        await measure();
        await flushHookEffects({ cycles: 20 });
        expect(selectedTab()).toMatchObject({ id: originalId, target: { kind: 'sessionDetails' } });
        await screen.pressByTestIdAsync('session-cockpit-tab-chat');
        await measure();
        await flushHookEffects({ cycles: 20 });
        expect(selectedTab()).toMatchObject({ id: originalId, target: { kind: 'session', params: { mobileSurface: 'chat' } } });
        expect(screen.findHostByTestId('session-cockpit-scene:chat')).not.toBeNull();
        expect(screen.findHostByTestId('session-details-screen')).toBeNull();
    } finally { await screen.unmount(); Object.assign(Platform, { OS: platform }); }
});
