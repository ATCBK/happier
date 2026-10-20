import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from '@/components/sessions/agentInput/agentInputTestHelpers';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

const focusObservation = vi.hoisted(() => ({
    readMainHidden: (): boolean | undefined => undefined,
    focusedWhileHidden: [] as (boolean | undefined)[],
}));
installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock, createFocusableTextInputMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: 1200, height: 900, scale: 1, fontScale: 1 }),
            TextInput: createFocusableTextInputMock(() => {
                focusObservation.focusedWhileHidden.push(focusObservation.readMainHidden());
            }),
        });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();

const { useAppPaneContext } = await import('@/components/appShell/panes/AppPaneProvider');
const { AppPaneScopeHost } = await import('@/components/appShell/panes/AppPaneScopeHost');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { usePaneMainColumn } = await import('@/components/appShell/panes/mainColumn/usePaneMainColumn');
const { buildDetailsWorkspaceStateView } = await import('@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors');
const { KeyboardShortcutProvider, useKeyboardCommand } = await import('@/keyboard/KeyboardShortcutProvider');
const { AgentInput } = await import('@/components/sessions/agentInput/AgentInput');
const { storage } = await import('@/sync/domains/state/storage');
const { useReviewComposerHandoff } = await import('./useReviewComposerHandoff');

afterEach(() => { vi.unstubAllGlobals(); focusObservation.focusedWhileHidden = []; });

describe('review composer handoff', () => {
    it('shows the retained session before focusing in Editor-first while keeping review state', async () => {
        const scopeId = 'session:review-handoff';
        storage.setState({ localSettings: { ...storage.getState().localSettings,
            paneArrangement: 'editor', uiMultiPanePanelsEnabled: true } });
        const refs: {
            pane: ReturnType<typeof useAppPaneScope> | null;
            main: ReturnType<typeof usePaneMainColumn>;
            handoff: (() => void) | null;
            requestFocus: (() => void) | null;
            command: ReturnType<typeof useKeyboardCommand> | null;
            setPresented: React.Dispatch<React.SetStateAction<boolean>> | null;
        } = { pane: null, main: null, handoff: null, requestFocus: null, command: null, setPresented: null };
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        focusObservation.readMainHidden = () => refs.main?.hidden;
        let sent = false;
        function Session() {
            const [presented, setPresented] = React.useState(true);
            const { dispatch } = useAppPaneContext();
            refs.pane = useAppPaneScope(scopeId);
            refs.main = usePaneMainColumn();
            refs.handoff = useReviewComposerHandoff(scopeId);
            refs.command = useKeyboardCommand();
            refs.setPresented = setPresented;
            React.useEffect(() => {
                dispatch({ type: 'openDetailsTab', scopeId, tab: {
                    key: 'scmReview:working', kind: 'scmReview', title: 'Review', resource: {},
                }, openAs: 'pinned' });
                dispatch({ type: 'setDetailsTabState', scopeId, tabKey: 'scmReview:working', nextState: { scrollTop: 120 } });
                dispatch({ type: 'openRight', scopeId, tabId: 'git' });
            }, [dispatch]);
            return <AgentInput value="Keep this draft" onChangeText={() => {}} onSend={() => { sent = true; }}
                placeholder="Message" autocompleteKinds={[]} autocompleteSuggestions={async () => []}
                surfacePresented={presented} onComposerFocusRequestChange={request => { refs.requestFocus = request; }} />;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><AppPaneScopeHost scopeId={scopeId} arrangement="honour"
            mainColumn={{ hideLabel: 'Hide session', showLabel: 'Show session', identity: { name: 'Session' } }}
            main={<Session />} emptyEditorPane={<div />} />
        </KeyboardShortcutProvider>, { wrapper: runtime.Wrapper });
        const retainedInput = screen.root.findByType(AgentInput);
        await act(async () => { refs.main?.setHidden(true); });
        expect(refs.main?.hidden).toBe(true);
        focusObservation.focusedWhileHidden = [];
        let commandHandled = false;
        await act(async () => { commandHandled = refs.command?.('composer.focus') ?? false; });
        expect(commandHandled).toBe(true);
        expect(refs.main?.hidden).toBe(false);
        expect(focusObservation.focusedWhileHidden.length).toBeGreaterThan(0);
        expect(focusObservation.focusedWhileHidden.every(hidden => hidden === false)).toBe(true);
        focusObservation.focusedWhileHidden = [];
        await act(async () => { refs.main?.setHidden(true); });
        await act(async () => {
            refs.handoff?.();
            await new Promise(resolve => setTimeout(resolve, 0));
        });
        expect(refs.pane?.scopeState?.details.isOpen).toBe(false);
        expect(refs.pane?.scopeState?.right.isOpen).toBe(false);
        const details = refs.pane?.scopeState?.details;
        expect(details && buildDetailsWorkspaceStateView(details).tabs.map(tab => tab.key)).toEqual(['scmReview:working']);
        expect(details?.tabState['scmReview:working']).toEqual({ scrollTop: 120 });
        expect(focusObservation.focusedWhileHidden).toEqual([]);
        await act(async () => { for (const callback of frames.splice(0)) callback(0); });
        expect(refs.main?.hidden).toBe(false);
        expect(refs.pane?.scopeState?.mainHidden).toBe(false);
        expect(focusObservation.focusedWhileHidden.length).toBeGreaterThan(0);
        expect(focusObservation.focusedWhileHidden.every(hidden => hidden === false)).toBe(true);
        expect(screen.root.findByType(AgentInput)).toBe(retainedInput);
        await act(async () => { refs.main?.setHidden(true); });
        expect(refs.requestFocus).toBeTypeOf('function');
        const beforeImperativeFocusCount = focusObservation.focusedWhileHidden.length;
        await act(async () => { refs.requestFocus?.(); });
        expect(refs.main?.hidden).toBe(false);
        expect(focusObservation.focusedWhileHidden.length).toBeGreaterThan(beforeImperativeFocusCount);
        expect(focusObservation.focusedWhileHidden.every(hidden => hidden === false)).toBe(true);
        const focusCount = focusObservation.focusedWhileHidden.length;
        await act(async () => { refs.setPresented?.(false); refs.main?.setHidden(true); });
        await act(async () => { refs.requestFocus?.(); refs.command?.('composer.focus'); });
        expect(refs.main?.hidden).toBe(true);
        expect(focusObservation.focusedWhileHidden.length).toBe(focusCount);
        expect(sent).toBe(false);
    });
});
