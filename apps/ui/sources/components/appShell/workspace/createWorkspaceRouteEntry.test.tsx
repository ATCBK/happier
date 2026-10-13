import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import PluginSettingsPageRoute from '@/app/(app)/settings/plugins/[pluginId]/[pageId]';
import PluginAppPageRootRoute from '@/app/(app)/plugins/[pluginId]/[localId]/index';
import PluginAppPageDeepLinkRoute from '@/app/(app)/plugins/[pluginId]/[localId]/[...subPath]';
import { PluginSurfaceFallback } from '@/components/sessions/panes/PluginSurfaceFallback';
import { WorkspaceRouteEntry } from './createWorkspaceRouteEntry';
import { WorkspaceNavigationContext, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';
import { createWorkspaceState } from './workspaceState';

const windowTitle = vi.hoisted(() => ({ options: null as Readonly<Record<string, unknown>> | null }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ stackOptionsCapture: {
        record: options => { windowTitle.options = typeof options === 'function' ? options() : options; },
        reset: () => { windowTitle.options = null; },
        getRaw: () => windowTitle.options, getResolved: () => windowTitle.options,
    } }).module;
});

function workspace(active: boolean): WorkspaceNavigationContextValue {
    return {
        active, ownsRoute: true,
        state: createWorkspaceState({ id: 'settings', target: { kind: 'settings', params: {} }, pinned: false, preview: true }),
        canGoBack: false, canGoForward: false, openHref: () => true,
        activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
        navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
        registerBackStep: () => () => {}, back: () => {}, forward: () => {},
    };
}

describe('WorkspaceRouteEntry', () => {
    it('publishes the focused live destination title to the Expo window owner while the editable body stays in its retained host', async () => {
        const ref = { kind: 'workflow', params: { id: 'deploy' } };
        const base = { ...workspace(true), state: createWorkspaceState({ id: 'workflow-tab', target: ref, pinned: false, preview: false }) };
        const element = (title: string) => <WorkspaceNavigationContext.Provider value={{ ...base,
            destinationTitles: { 'workflow-tab': { ref, title } },
        }}><WorkspaceRouteEntry Body={() => { throw new Error('Expo must not mount the workspace body'); }} /></WorkspaceNavigationContext.Provider>;
        const screen = await renderScreen(element('Deploy Lumen'));
        expect(windowTitle.options?.title).toBe('Deploy Lumen');
        await screen.update(element('Deploy renamed'));
        expect(windowTitle.options?.title).toBe('Deploy renamed');
    });
    it.each([
        { route: 'Settings', RouteEntry: PluginSettingsPageRoute, testID: 'plugin-settings-page-hydrating' },
        { route: 'App root', RouteEntry: PluginAppPageRootRoute, testID: 'plugin-app-page-hydrating' },
        { route: 'App deep link', RouteEntry: PluginAppPageDeepLinkRoute, testID: 'plugin-app-page-hydrating' },
    ])('uses the plugin $route skeleton before Account/workspace hydration admits its body', async ({ RouteEntry, testID }) => {
        const screen = await renderScreen(<WorkspaceNavigationContext.Provider value={workspace(false)}>
            <RouteEntry />
        </WorkspaceNavigationContext.Provider>);
        expect(screen.findByTestId(`${testID}-loading-skeleton`)).not.toBeNull();
        expect(screen.getTextContent()).toBe('');
    });
    it('keeps the page-shaped loading fallback until the retained route owns the body, without mounting a temporary editable page', async () => {
        let mountedBodies = 0;
        function Body() { mountedBodies += 1; return React.createElement('EditablePage'); }
        const page = (active: boolean) => <WorkspaceNavigationContext.Provider value={workspace(active)}>
            <WorkspaceRouteEntry Body={Body} loadingFallback={<PluginSurfaceFallback testID="cold-plugin-page" state="loading" />} />
        </WorkspaceNavigationContext.Provider>;
        const screen = await renderScreen(page(false));
        expect(screen.findByTestId('cold-plugin-page-loading-skeleton')).not.toBeNull();
        expect(screen.getTextContent()).toBe('');
        expect(mountedBodies).toBe(0);
        await screen.update(page(true));
        expect(screen.findByTestId('cold-plugin-page-loading-skeleton')).toBeNull();
        expect(mountedBodies).toBe(0);
    });
});
