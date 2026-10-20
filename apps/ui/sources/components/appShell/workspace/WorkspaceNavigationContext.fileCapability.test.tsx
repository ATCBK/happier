import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { createWorkspaceState } from './workspaceState';
import { WorkspaceNavigationProvider, useWorkspaceFileNavigationCapabilities, type WorkspaceNavigationContextValue } from './WorkspaceNavigationContext';

describe('file opener capability subscription', () => {
    it('does not render a file opener on unrelated workspace-state changes', async () => {
        let renders = 0;
        const Probe = React.memo(function Probe() {
            const { canOpen } = useWorkspaceFileNavigationCapabilities();
            renders++;
            return React.createElement('probe', { canOpen });
        });
        const state = createWorkspaceState({ id: 'session', target: { kind: 'session', params: { id: 's1' } }, pinned: true, preview: false });
        const value = {
            active: true, state, canGoBack: false, canGoForward: false,
            openHref: () => false, activateTab: () => {}, closeTab: () => {}, closeTabs: () => {},
            dispatch: () => {}, navigationForTab: () => ({ push: () => {}, replace: () => {}, back: () => {} }),
            registerBackStep: () => () => {}, back: () => {}, forward: () => {},
        } satisfies WorkspaceNavigationContextValue;
        const child = <Probe />;
        const screen = await renderScreen(<WorkspaceNavigationProvider value={value}>{child}</WorkspaceNavigationProvider>);
        const before = renders;
        await screen.update(<WorkspaceNavigationProvider value={{ ...value, canGoBack: true }}>{child}</WorkspaceNavigationProvider>);
        expect(renders).toBe(before);
        await screen.update(<WorkspaceNavigationProvider value={{ ...value, active: false }}>{child}</WorkspaceNavigationProvider>);
        expect(renders).toBe(before + 1);
        await screen.unmount();
    });
});
