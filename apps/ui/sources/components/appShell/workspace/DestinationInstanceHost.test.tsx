import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { usePluginSurfaceFocusEligibility, usePluginSurfaceCurrentUiContextEligibility, useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { createWorkspaceState } from './workspaceState';
import { Stack } from './destinationRoute';
import { useClaimedStackHeaderActions } from '@/components/navigation/stackHeaderActions';
import { NavigationHeaderActions, PageNavigationContextActionsProvider } from '@/components/ui/layout/NavigationHeaderActions';
import { resolveCompactAppDestinations } from '../destinations/compactAppDestinationCatalog';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { t } from '@/text';
import {
    DestinationInstanceHost,
    useDestinationFocus,
    useDestinationGlobalParams,
    useDestinationInstanceKey,
    useDestinationParams,
    useDestinationPathname,
    useDestinationRouter,
    useDestinationVisibility,
} from './DestinationInstanceHost';

const expoHooks = vi.hoisted(() => ({ reject: false }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const module = createExpoRouterMock({ pathname: '/settings', params: { pageId: 'global' } }).module;
    const guard = <T,>(hook: () => T) => () => {
        if (expoHooks.reject) throw new Error('Hosted bodies have no Expo navigator');
        return hook();
    };
    return { ...module, useGlobalSearchParams: guard(() => ({ pageId: 'global-route' })),
        useLocalSearchParams: guard(module.useLocalSearchParams),
        usePathname: guard(module.usePathname), useRouter: guard(module.useRouter) };
});

function IdentityProbe() {
    const params = useDestinationParams<{ id?: string; serverId?: string; pageId?: string }>();
    return React.createElement('IdentityProbe', {
        params,
        pathname: useDestinationPathname(),
        focused: useDestinationFocus(),
        visible: useDestinationVisibility(),
        instanceKey: useDestinationInstanceKey(),
    });
}

function NavigationProbe() {
    const router = useDestinationRouter();
    return React.createElement('NavigationProbe', { open: () => router.push('/settings/appearance') });
}

function GlobalParamsProbe() {
    return React.createElement('GlobalParamsProbe', { params: useDestinationGlobalParams() });
}

function FocusProbe() {
    return React.createElement('FocusProbe', {
        focused: useDestinationFocus(),
        pluginFocus: usePluginSurfaceFocusEligibility(),
        currentContext: usePluginSurfaceCurrentUiContextEligibility(),
        presented: useLayoutPresentationActive(),
    });
}

const pageHeaderOptions = { headerRight: () => React.createElement('MachineContextChip', { testID: 'machine-context' }) };
function PageHeaderActionsProbe() {
    const actions = useClaimedStackHeaderActions();
    return React.createElement('PageHeaderActionsProbe', {}, actions);
}

describe('DestinationInstanceHost', () => {
    it('inherits the root declaration for a phone page before any leaf options arrive', async () => {
        const screen = await renderScreen(<DestinationInstanceHost tabId="history-phone" phone
            ref={{ kind: 'sessionRecent', params: {} }} pathname="/session/recent" focused visible>
            {React.createElement('HistoryBody')}
        </DestinationInstanceHost>);
        expect(screen.findByTestId('workspace-destination-header')).not.toBeNull();
        expect(screen.getTextContent()).toContain(t('sessionHistory.title'));
    });
    it('keeps an Artifacts PageHeader and its actions in the page without a second phone bar', async () => {
        const screen = await renderScreen(<DestinationInstanceHost tabId="artifacts-phone" phone
            ref={{ kind: 'artifacts', params: {} }} pathname="/artifacts" focused visible>
            <Stack.Screen options={{ headerRight: () => React.createElement('CreateArtifact') }} />
            <PageHeader title="Artifacts" alwaysShowTitle actions={React.createElement('ArtifactActions')} />
        </DestinationInstanceHost>);
        expect(screen.findByTestId('workspace-destination-header')).toBeNull();
        expect(screen.getTextContent()).toContain('Artifacts');
        expect(screen.root.findAllByType('ArtifactActions')).toHaveLength(1);
        expect(screen.root.findAllByType('CreateArtifact')).toHaveLength(1);
    });
    it('hands hosted desktop route actions to the page header once and retains them when content is loading', async () => {
        const page = (ready: boolean) => <DestinationInstanceHost tabId="header-tab"
            ref={{ kind: 'settings', params: {} }} pathname="/settings" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <Stack.Screen options={pageHeaderOptions} />
            {ready ? <PageHeaderActionsProbe /> : React.createElement('LoadingBody')}
        </DestinationInstanceHost>;
        const screen = await renderScreen(page(true));
        expect(screen.root.findByType('PageHeaderActionsProbe').findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
        await screen.update(page(false));
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
    });
    it('keeps phone route context beside page actions and after the renderer returns to loading', async () => {
        const page = (ready: boolean) => <DestinationInstanceHost tabId="phone-header-tab" phone
            ref={{ kind: 'settings', params: {} }} pathname="/settings" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <Stack.Screen options={pageHeaderOptions} />
            <PageNavigationContextActionsProvider actions={pageHeaderOptions.headerRight()}>
                {ready ? <NavigationHeaderActions primary={{ title: 'Save', onPress: () => {} }} /> : React.createElement('LoadingBody')}
            </PageNavigationContextActionsProvider>
        </DestinationInstanceHost>;
        const screen = await renderScreen(page(true));
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
        await screen.update(page(false));
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
    });
    it('withdraws old phone context when its provider and destination leave', async () => {
        const page = (first: boolean) => <DestinationInstanceHost tabId={first ? 'first-phone' : 'second-phone'} phone
            ref={{ kind: 'settings', params: {} }} pathname="/settings" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <Stack.Screen options={first ? pageHeaderOptions : { title: 'Other page' }} />
            {first ? <PageNavigationContextActionsProvider actions={pageHeaderOptions.headerRight()}>
                <NavigationHeaderActions primary={{ title: 'Save', onPress: () => {} }} />
            </PageNavigationContextActionsProvider> : React.createElement('OtherPage')}
        </DestinationInstanceHost>;
        const screen = await renderScreen(page(true));
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(1);
        await screen.update(page(false));
        expect(screen.root.findAllByProps({ testID: 'machine-context' })).toHaveLength(0);
    });
    it('gives unhosted shell consumers the focused workspace route before Expo mirrors it', async () => {
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: false, workflows: true, friends: false } });
        const value = (id: string | null): WorkspaceNavigationContextValue => ({
            active: true, catalog,
            state: createWorkspaceState({ id: 'workflow-tab', target: id === null ? { kind: 'workflows', params: {} }
                : { kind: 'workflow', params: { id } }, pinned: false, preview: false }),
            canGoBack: false, canGoForward: false, openHref: () => true,
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        });
        const screen = await renderScreen(<WorkspaceNavigationContext.Provider value={value('qa-checklist')}><IdentityProbe /></WorkspaceNavigationContext.Provider>);
        expect(screen.root.findByType('IdentityProbe').props.pathname).toBe('/workflows/qa-checklist');
        await screen.update(<WorkspaceNavigationContext.Provider value={value(null)}><IdentityProbe /></WorkspaceNavigationContext.Provider>);
        expect(screen.root.findByType('IdentityProbe').props.pathname).toBe('/workflows');
    });
    it('gives only the visible focused destination plugin focus and semantic current-context eligibility', async () => {
        const screen = await renderScreen(<>
            {[{ id: 'focused', focused: true, visible: true }, { id: 'sibling', focused: false, visible: true },
                { id: 'hidden', focused: true, visible: false }].map((tab) => <DestinationInstanceHost key={tab.id}
                    tabId={tab.id} ref={{ kind: 'newTab', params: {} }} pathname="/" focused={tab.focused} visible={tab.visible}>
                    <FocusProbe />
                </DestinationInstanceHost>)}
        </>);
        expect(screen.root.findAllByType('FocusProbe').map((node) => node.props)).toEqual([
            { focused: true, pluginFocus: true, currentContext: true, presented: true },
            { focused: false, pluginFocus: false, currentContext: false, presented: true },
            { focused: false, pluginFocus: false, currentContext: false, presented: false },
        ]);
    });
    it('retains the unhosted router across workspace publications while navigation reads current history and focus', async () => {
        function RouterProbe() {
            return React.createElement('RouterProbe', { router: useDestinationRouter() });
        }
        const opened: string[] = [];
        const workspace: WorkspaceNavigationContextValue = {
            active: true,
            state: createWorkspaceState({ id: 'first', target: { kind: 'newTab', params: {} }, pinned: false, preview: false }),
            canGoBack: false, canGoForward: false,
            openHref: href => { opened.push(`original:${href}`); return true; },
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: tabId => ({ push: () => {}, replace: () => {}, back: () => {},
                pushRetainingCurrent: () => { opened.push(`retained:${tabId}`); },
                retainCurrent: () => { opened.push(`promoted:${tabId}`); } }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        };
        const render = (value: WorkspaceNavigationContextValue) => <WorkspaceNavigationContext.Provider value={value}>
            <RouterProbe />
        </WorkspaceNavigationContext.Provider>;
        const screen = await renderScreen(render(workspace));
        const readRouter = () => screen.root.findByType('RouterProbe').props.router as ReturnType<typeof useDestinationRouter>;
        const initial = readRouter();
        expect(initial.canGoBack()).toBe(false);
        await screen.update(render({ ...workspace, canGoBack: true,
            state: createWorkspaceState({ id: 'second', target: { kind: 'newTab', params: {} }, pinned: false, preview: false }) }));
        expect.soft(readRouter()).toBe(initial);
        expect(readRouter().canGoBack()).toBe(true);
        readRouter().pushRetainingCurrent('/settings/appearance');
        readRouter().retainCurrent();
        expect(opened).toEqual(['retained:second', 'promoted:second']);
        await screen.update(render({ ...workspace, openHref: href => { opened.push(`replacement:${href}`); return true; } }));
        expect(readRouter()).not.toBe(initial);
        initial.push('/settings/appearance');
        readRouter().push('/settings/appearance');
        expect(opened.slice(-2)).toEqual(['original:/settings/appearance', 'replacement:/settings/appearance']);
        await screen.unmount();
    });
    it('preserves native global search parameters outside the workspace', async () => {
        const screen = await renderScreen(<GlobalParamsProbe />);
        expect(screen.root.findByType('GlobalParamsProbe').props.params).toEqual({ pageId: 'global-route' });
    });
    it('does not require Expo hooks when a destination supplies identity and navigation', async () => {
        expoHooks.reject = true;
        try {
            const screen = await renderScreen(React.createElement(DestinationInstanceHost, {
                tabId: 'settings-tab', ref: { kind: 'settings', params: { pageId: 'appearance' } },
                pathname: '/settings/appearance', focused: true, visible: true,
                navigation: { push: () => {}, replace: () => {}, back: () => {} },
                children: React.createElement(React.Fragment, null,
                    React.createElement(IdentityProbe), React.createElement(NavigationProbe),
                    React.createElement(GlobalParamsProbe)),
            }));
            expect(screen.root.findByType('IdentityProbe').props.pathname).toBe('/settings/appearance');
            expect(screen.root.findByType('GlobalParamsProbe').props.params).toEqual({ pageId: 'appearance' });
        } finally { expoHooks.reject = false; }
    });
    it('gives concurrent destinations separate identity, focus, and visibility outside the Stack', async () => {
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(DestinationInstanceHost, {
                tabId: 'tab-a', ref: { kind: 'session', params: { id: 'A', serverId: 'home-a' } },
                pathname: '/session/A', focused: true, visible: true,
                children: React.createElement(IdentityProbe),
            }),
            React.createElement(DestinationInstanceHost, {
                tabId: 'tab-b', ref: { kind: 'settings', params: { pageId: 'appearance' } },
                pathname: '/settings/appearance', focused: false, visible: true,
                children: React.createElement(IdentityProbe),
            }),
        ));
        expect(screen.root.findAllByType('IdentityProbe').map((node) => node.props)).toEqual([
            { params: { id: 'A', serverId: 'home-a' }, pathname: '/session/A', focused: true, visible: true, instanceKey: 'tab-a' },
            { params: { pageId: 'appearance' }, pathname: '/settings/appearance', focused: false, visible: true, instanceKey: 'tab-b' },
        ]);
    });

    it('sends each hosted page action through its own tab navigation owner', async () => {
        const opened: string[] = [];
        const screen = await renderScreen(React.createElement(React.Fragment, null,
            React.createElement(DestinationInstanceHost, {
                tabId: 'tab-a', ref: { kind: 'session', params: { id: 'A' } }, pathname: '/session/A',
                focused: true, visible: true,
                navigation: { push: () => { opened.push('tab-a'); }, replace: () => {}, back: () => {} },
                children: React.createElement(NavigationProbe),
            }),
            React.createElement(DestinationInstanceHost, {
                tabId: 'tab-b', ref: { kind: 'session', params: { id: 'B' } }, pathname: '/session/B',
                focused: false, visible: true,
                navigation: { push: () => { opened.push('tab-b'); }, replace: () => {}, back: () => {} },
                children: React.createElement(NavigationProbe),
            }),
        ));
        screen.root.findAllByType('NavigationProbe').forEach((node) => node.props.open());
        expect(opened).toEqual(['tab-a', 'tab-b']);
    });
});
