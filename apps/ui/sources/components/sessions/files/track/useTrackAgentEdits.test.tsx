import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PanePresentationProvider } from '@/components/appShell/panes/panePresentation';
import { createWorkspaceFileDetailsTab } from '@/components/appShell/panes/details/fileDetailsTab';
import { act, renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';

import { useTrackAgentEdits, type TrackFileOpen } from './useTrackAgentEdits';
import type { TrackWrite } from './trackAgentEditsController';

const originalState = storage.getState();
afterEach(() => { storage.setState(originalState, true); });
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe('Track through the real pane and local setting owners', () => {
    it('keeps a single unpinned preview, does not present navigation, and pauses before replacing a dirty editor', async () => {
        storage.setState({ localSettings: { ...originalState.localSettings, filesTrackAgentEdits: true, detailsPaneTabsBehavior: 'preview' } });
        const present = vi.fn();
        const revealRegion = vi.fn(); // The editor viewport is an imperative platform boundary.
        const initialProps = { writes: new Map<string, TrackWrite>([['a.ts', {
            toolCallId: 'a', sessionId: 'session', startedAt: 1, region: { startLine: 14, endLine: 16 },
        }]]), dirtyPaths: new Set<string>() };
        const hook = await renderHook((props: typeof initialProps) => {
            const pane = useAppPaneScope('session:track-contract');
            // This consumer-level test exercises the real pane. P3's async opener binding is a later composed gate.
            const openFile = React.useCallback<TrackFileOpen>((target, options) => {
                pane.openDetailsTab(createWorkspaceFileDetailsTab(target.path, options.anchor, options.anchorSource), options);
            }, [pane]);
            const track = useTrackAgentEdits({ scopeId: 'session:track-contract', sessionAddress: { serverId: 'home', sessionId: 'session' },
                active: true, sessionActive: true, ...props, reducedMotion: false, revealRegion, openFile });
            return { track, pane };
        }, { initialProps, wrapper: ({ children }) => <AppPaneProvider>
            <PanePresentationProvider value={present}>{children}</PanePresentationProvider>
        </AppPaneProvider> });
        const tab = () => hook.getCurrent().pane.scopeState?.details.tabs[0];
        expect(tab()).toMatchObject({ key: 'file:a.ts', isPreview: true, isPinned: false,
            resource: { anchor: { kind: 'fileLine', startLine: 14 } } });
        expect(present).not.toHaveBeenCalled();
        await hook.rerender({ ...initialProps, writes: new Map([['a.ts', {
            toolCallId: 'a2', sessionId: 'session', startedAt: 2, region: { startLine: 20, endLine: 21 },
        }]]) });
        expect(tab()).toMatchObject({ key: 'file:a.ts', isPreview: true, isPinned: false });
        expect(revealRegion.mock.calls.at(-1)?.[0]).toMatchObject({ region: { startLine: 20 } });
        const nextWrites = new Map<string, TrackWrite>([['b.ts', {
            toolCallId: 'b', sessionId: 'session', startedAt: 3, region: { startLine: 30, endLine: 30 },
        }]]);
        await hook.rerender({ writes: nextWrites, dirtyPaths: new Set(['a.ts']) });
        expect(hook.getCurrent().track).toMatchObject({ paused: true, pauseReason: 'dirtyEditor' });
        expect(tab()?.key).toBe('file:a.ts');
        await hook.rerender({ writes: nextWrites, dirtyPaths: new Set() });
        expect(tab()?.key).toBe('file:a.ts');
        await act(async () => { hook.getCurrent().track.resume(); });
        expect(tab()).toMatchObject({ key: 'file:b.ts', isPreview: true, isPinned: false });
        expect(present).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
