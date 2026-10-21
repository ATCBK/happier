import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';
import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';

installSessionDetailsPanelCommonModuleMocks();
const runtime = installSessionPaneRuntimeTestHarness();

const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
function panel() {
    return <runtime.Wrapper><SessionDetailsPanel sessionId="s1" routeServerId={runtime.serverId} scopeId="session:s1" /></runtime.Wrapper>;
}
async function openPreview() {
    await act(async () => runtime.pane.openDetailsTab({
        key: 'file:a', kind: 'file', title: 'a.txt', resource: { kind: 'file', path: 'a.txt' },
    }, { intent: 'preview' }));
}

describe('SessionDetailsPanel (auto pin on edit)', () => {
    it('opens empty-editor Recent and Changed rows through the qualified pinned file Action', async () => {
        const { EmptyEditorPage } = await import('@/components/workspaces/files/EmptyEditorPage');
        const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
        const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
        const admitted = vi.fn(async () => ({ ok: true as const }));
        const unregister = registerMountedWorkspaceAction(admitted);
        const navigation = {
            active: true, state: createWorkspaceState({ id: 'session', target: { kind: 'session' as const, params: { id: 's1' } }, pinned: true, preview: false }),
            canGoBack: false, canGoForward: false, openHref: () => false,
            activateTab: () => {}, closeTab: () => {}, closeTabs: () => {}, dispatch: () => {},
            navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        };
        try {
            const screen = await renderScreen(<WorkspaceNavigationProvider value={navigation}>{panel()}</WorkspaceNavigationProvider>);
            await act(async () => screen.tree.findByType(EmptyEditorPage).props.onOpenFile('src/recent.ts'));
            await vi.waitFor(() => expect(admitted).toHaveBeenCalledWith(expect.objectContaining({
                actionId: 'workspace.tabs.open', input: { file: { target: { kind: 'session', sessionId: 's1', serverId: runtime.serverId }, path: 'src/recent.ts' }, mode: 'newTab' },
            })));
            // The navigation owner, rather than this panel, gets custody of constructing the tab.
            expect(runtime.pane.scopeState?.details.tabs ?? []).toHaveLength(0);
        } finally { unregister(); }
    });

    it('pins a preview file tab when editing begins', async () => {
        const { SessionFileDetailsView } = await import('@/components/sessions/files/views/SessionFileDetailsView');
        const screen = await renderScreen(panel());
        await openPreview();
        const views = screen.tree.findAllByType(SessionFileDetailsView);
        expect(views).toHaveLength(1);
        expect(runtime.pane.scopeState?.details.tabs[0]).toMatchObject({ key: 'file:a', isPreview: true, isPinned: false });
        expect(typeof views[0].props.onStartEditingFile).toBe('function');
        await act(async () => views[0].props.onStartEditingFile());
        expect(runtime.pane.scopeState?.details.tabs[0]).toMatchObject({ key: 'file:a', isPreview: false, isPinned: true });
    });

    it('keeps the file edit callback stable across unchanged panel rerenders', async () => {
        const { SessionFileDetailsView } = await import('@/components/sessions/files/views/SessionFileDetailsView');
        const screen = await renderScreen(panel());
        await openPreview();
        const firstCallback = screen.tree.findByType(SessionFileDetailsView).props.onStartEditingFile;
        expect(typeof firstCallback).toBe('function');
        await screen.update(panel());
        expect(screen.tree.findByType(SessionFileDetailsView).props.onStartEditingFile).toBe(firstCallback);
        // The retained callback remains connected to the live reducer after the rerender.
        await act(async () => firstCallback());
        expect(runtime.pane.scopeState?.details.tabs[0]).toMatchObject({ key: 'file:a', isPinned: true, isPreview: false });
    });
});
