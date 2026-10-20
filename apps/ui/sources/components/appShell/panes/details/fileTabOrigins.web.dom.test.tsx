/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { storage } from '@/sync/domains/state/storage';
import { AppPaneProvider, useAppPaneContext } from '../AppPaneProvider';
import { useAppPaneScope, type AppPaneScopeApi } from '../hooks/useAppPaneScope';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initialState = storage.getState();
beforeEach(() => storage.setState(initialState, true));
afterEach(() => storage.setState(initialState, true));

it('returns focus to the originating control when its docked file tab closes', async () => {
    let pane: AppPaneScopeApi | undefined;
    let context: ReturnType<typeof useAppPaneContext> | undefined;
    function Probe() {
        pane = useAppPaneScope('session:file-origin');
        context = useAppPaneContext();
        return <><button id="file-origin">Open file</button><button id="file-body">File body</button></>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await act(async () => root.render(<AppPaneProvider><Probe /></AppPaneProvider>));
        const trigger = container.querySelector<HTMLButtonElement>('#file-origin')!;
        trigger.focus();
        await act(async () => pane!.openDetailsTab({ key: 'file:a.ts', kind: 'file', title: 'a.ts', resource: { kind: 'file', path: 'a.ts' } }));
        context!.overlayFocusReturnOwner.getRef('session:file-origin', 'details').current = trigger;
        container.querySelector<HTMLButtonElement>('#file-body')!.focus();
        await act(async () => pane!.closeDetailsTab('file:a.ts'));
        expect(document.activeElement).toBe(trigger);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
