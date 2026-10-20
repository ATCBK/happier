import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    projectSessionBoard,
    type SessionBoardActionsPort,
} from '@/sync/domains/session/board';

import { SessionBoardContinuityProvider } from './SessionBoardContinuity';
import type { SessionBoardController } from './useSessionBoardController';
import { useSessionBoardNoteEditor, type SessionBoardNoteEditor } from './note/useSessionBoardNoteEditor';
import {
    SessionBoardControllerOwner,
    SessionBoardControllerProvider,
    useMountedSessionBoardController,
} from './SessionBoardControllerProvider';

const actions: SessionBoardActionsPort = {
    upsertItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
    removeItem: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
    updateLayout: async () => ({ status: 'unavailable', reason: 'board_actions_unavailable' }),
};

const snapshot = projectSessionBoard({
    layout: undefined,
    items: new Map(),
    capabilities: { readTranscript: true, editSessionRecords: true },
    freshness: 'fresh',
    reachability: 'reachable',
    loading: 'idle',
    incomplete: false,
});

describe('SessionBoardContinuityProvider', () => {
    afterEach(() => standardCleanup());

    it('keeps one controller owner and final unsaved Note text across Board host remounts', async () => {
        let editor: SessionBoardNoteEditor | null = null;
        const mountedControllers = new Map<string, SessionBoardController>();
        const mountedSnapshots = new Map<string, typeof snapshot>();

        function Editor(props: Readonly<{ itemId: string }>) {
            editor = useSessionBoardNoteEditor({
                sessionId: 'session-1',
                itemId: props.itemId,
                expectedItemRevision: null,
                reachable: true,
                actions,
            });
            return null;
        }

        function BoardHost(props: Readonly<{ hostKey: string }>) {
            const mounted = useMountedSessionBoardController({ serverId: 'home-1', sessionId: 'session-1' });
            if (mounted) {
                mountedControllers.set(props.hostKey, mounted.controller);
                if (mounted.binding.status === 'ready') mountedSnapshots.set(props.hostKey, mounted.binding.snapshot);
            }
            return mounted?.controller.noteDraft
                ? <Editor key={props.hostKey} itemId={mounted.controller.noteDraft.itemId} />
                : null;
        }

        const requireController = (hostKey: string): SessionBoardController => {
            const mounted = mountedControllers.get(hostKey);
            if (!mounted) throw new Error(`Board controller was not mounted for ${hostKey}`);
            return mounted;
        };
        const requireEditor = (): SessionBoardNoteEditor => {
            if (!editor) throw new Error('Board Note editor was not mounted');
            return editor;
        };

        const controllerInput = {
            sessionId: 'session-1',
            serverId: 'home-1',
            binding: { status: 'ready' as const, snapshot, refresh: () => {} },
            actions,
        };
        const pluginRuntime = {
            accountLifetime: null,
            pluginUiProjection: null,
            pluginBrowserProjection: null,
            phase: 'unavailable' as const,
            interactionEnabled: false,
            machineId: null,
            serverId: 'home-1',
            platform: 'web' as const,
        };
        const owner = (children: React.ReactNode) => (
            <SessionBoardContinuityProvider sessionId="session-1" serverId="home-1">
                <SessionBoardControllerOwner
                    address={{ serverId: 'home-1', sessionId: 'session-1' }}
                    input={controllerInput}
                    binding={controllerInput.binding}
                    actions={actions}
                    pluginRuntime={pluginRuntime}
                    callerHostedHtmlRuntime={null}
                >
                    {children}
                </SessionBoardControllerOwner>
            </SessionBoardContinuityProvider>
        );
        const screen = await renderScreen(owner(<><BoardHost hostKey="details" /><BoardHost hostKey="sidebar" /></>));

        // Details, sidebar, focused Details, mobile and Companion are projections
        // of one exact-Session controller. Two physical hosts must not create two
        // command/reconciliation owners merely because both are mounted.
        expect(mountedControllers.get('details')).toBe(mountedControllers.get('sidebar'));
        expect(mountedSnapshots.get('details')).toBe(mountedSnapshots.get('sidebar'));

        await act(async () => {
            await requireController('details').run({ kind: 'add', intent: 'note' });
        });
        const draftItemId = requireController('details').noteDraft?.itemId;
        expect(draftItemId).toBeTruthy();

        act(() => {
            requireEditor().setBody('the final unsaved character');
        });
        expect(requireEditor().body).toBe('the final unsaved character');

        await screen.update(owner(<BoardHost hostKey="mobileCockpit" />));

        expect(requireController('mobileCockpit').noteDraft?.itemId).toBe(draftItemId);
        expect(requireEditor().body).toBe('the final unsaved character');
        expect(requireEditor().dirtyRef.current).toBe(true);
        // The controller value is a reactive projection and may receive a new
        // object identity when its state changes. The shared owner is proved by
        // the draft/edit continuity and by simultaneous hosts sharing one value.
        expect(mountedControllers.get('mobileCockpit')).toBeTruthy();
        expect(mountedSnapshots.get('mobileCockpit')).toBe(mountedSnapshots.get('details'));
    });

    it('reuses an existing exact-Session shell owner instead of forking a nested controller', async () => {
        const observed: SessionBoardController[] = [];

        function Probe() {
            const mounted = useMountedSessionBoardController({
                serverId: 'home-1',
                sessionId: 'session-1',
            });
            if (mounted) observed.push(mounted.controller);
            return null;
        }

        const controllerInput = {
            sessionId: 'session-1',
            serverId: 'home-1',
            binding: { status: 'ready' as const, snapshot, refresh: () => {} },
            actions,
        };
        const pluginRuntime = {
            accountLifetime: null,
            pluginUiProjection: null,
            pluginBrowserProjection: null,
            phase: 'unavailable' as const,
            interactionEnabled: false,
            machineId: null,
            serverId: 'home-1',
            platform: 'web' as const,
        };

        await renderScreen(
            <SessionBoardContinuityProvider sessionId="session-1" serverId="home-1">
                <SessionBoardControllerOwner
                    address={{ serverId: 'home-1', sessionId: 'session-1' }}
                    input={controllerInput}
                    binding={controllerInput.binding}
                    actions={actions}
                    pluginRuntime={pluginRuntime}
                    callerHostedHtmlRuntime={null}
                >
                    <Probe />
                    <SessionBoardControllerProvider sessionId="session-1" serverId="home-1">
                        <Probe />
                    </SessionBoardControllerProvider>
                </SessionBoardControllerOwner>
            </SessionBoardContinuityProvider>,
        );

        expect(observed).toHaveLength(2);
        expect(observed[1]).toBe(observed[0]);
    });

});
