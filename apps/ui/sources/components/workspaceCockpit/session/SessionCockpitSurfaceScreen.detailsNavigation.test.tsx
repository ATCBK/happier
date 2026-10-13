import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { flushHookEffects, invokeTestInstanceHandler, standardCleanup } from '@/dev/testkit';
import {
    createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries,
} from '@/components/sessions/files/views/sessionFilesViewTestkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const route = vi.hoisted(() => ({ params: {} as Record<string, string>, replace: vi.fn() }));
const Focus = React.createContext(true);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installSessionFilesViewBoundaries();
vi.doMock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    pathname: () => '/session/s1/details', params: () => route.params,
    router: { replace: (href: unknown) => route.replace(href) },
}).module);
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
afterEach(async () => { await standardCleanup(); await fixture?.dispose(); });

it.each([true, false])('leaves phone Details through the real comparison Back with pane open=%s without deleting its retained tab', async (paneOpen) => {
    const snapshot = fileViewSnapshot({ rootPath: '/tmp/repo' });
    fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: request =>
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
