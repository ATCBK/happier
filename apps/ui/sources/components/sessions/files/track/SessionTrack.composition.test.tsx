import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReducer } from '@happier-dev/session-core/reducer';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import { act, createSessionFixture, createToolCallMessageFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { useSessionTrack } = await import('./SessionTrack');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
const { PanePresentationProvider } = await import('@/components/appShell/panes/panePresentation');
const { WorkspaceNavigationProvider } = await import('@/components/appShell/workspace/WorkspaceNavigationContext');
const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
const { createWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
const { resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
const { createWorkspaceFileDetailsTab } = await import('@/components/appShell/panes/details/fileDetailsTab');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');

const original = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let unregister: (() => void) | undefined;
afterEach(async () => {
    unregister?.();
    unregister = undefined;
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    publishAppliedActiveServerRuntimeAvailability(false);
    storage.setState(original, true);
});

describe('Session Track composition', () => {
    it('follows the current writing file through the real opener without navigating or presenting Details', async () => {
        const serverUrl = 'https://session-track-composition.test';
        const serverId = await homes.addHome({ name: 'session-track-composition', serverUrl, accountId: 'alice', currentAccount: true });
        const emptySessions = V2SessionListResponseSchema.parse({ sessions: [], hasNext: false, nextCursor: null });
        homes.answer(serverId, '/v2/sessions', { body: emptySessions });
        homes.answer(serverId, '/v2/sessions/active', { body: emptySessions });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
        if (!credentials) throw new Error('Expected Home credentials');
        connection = await restoreServerAccountForTest({ serverUrl, accountId: 'alice', credentials, request: homes.request });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const sessionId = 'track-session';
        const scopeId = 'session:track-composition';
        const session = createSessionFixture({ id: sessionId, serverId, active: true, activeAt: Date.now(),
            thinking: true, thinkingAt: Date.now(), latestTurnStatus: 'in_progress',
            metadata: { machineId: 'machine', path: '/repo', host: 'test' } });
        const message = createToolCallMessageFixture({ id: 'write-a', tool: {
            id: 'write-a', name: 'Write', input: { file_path: '/repo/a.ts', content: 'hello' },
            state: 'running', createdAt: 1, startedAt: 2, completedAt: null, description: null,
        } });
        const messagesById = { [message.id]: message };
        storage.setState({ sessions: { [sessionId]: session },
            localSettings: { ...storage.getState().localSettings, filesTrackAgentEdits: true, detailsPaneTabsBehavior: 'preview' },
            sessionMessages: { [sessionId]: { messageIdsOldestFirst: [message.id], messagesById, messagesMap: messagesById,
                reducerState: createReducer(), messagesVersion: 1, isLoaded: true,
                latestThinkingMessageId: null, latestThinkingMessageActivityAtMs: null } } });
        const state = createWorkspaceState({ id: 'session-tab', target: { kind: 'session', params: { id: sessionId, serverId } }, pinned: true, preview: false });
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: false, friends: false } });
        const hrefs: string[] = [];
        const navigation = createWorkspaceNavigationAdapter({ getState: () => state, getCatalog: () => catalog,
            dispatch: () => {}, createId: () => 'opened-tab', onChange: () => {}, transport: { commit: href => { hrefs.push(href); } } });
        const present = vi.fn();
        const hook = await renderHook(() => {
            const pane = useAppPaneScope(scopeId);
            const paneRef = React.useRef(pane);
            paneRef.current = pane;
            React.useLayoutEffect(() => {
                const execute = createWorkspaceActionAdapter({ getState: () => state, navigation, readCanvas: () => null, createId: () => 'opened-tab',
                    // The mounted Details viewport is the imperative UI boundary. Its real pane owner handles preview and presentation.
                    openFileInPlace: file => {
                        paneRef.current.openDetailsTab(createWorkspaceFileDetailsTab(file.path, file.anchor, file.anchorSource), { intent: 'preview', present: false });
                        return true;
                    } });
                unregister = registerMountedWorkspaceAction(async request => execute(request.actionId, request.input));
                return unregister;
            }, []);
            const track = useSessionTrack({ scopeId, sessionAddress: { serverId, sessionId }, workspaceRoot: '/repo', active: true });
            return { pane, track };
        }, { wrapper: ({ children }) => <AppPaneProvider><PanePresentationProvider value={present}>
            <WorkspaceNavigationProvider value={{ active: true, state, canGoBack: false, canGoForward: false,
                openHref: () => false, activateTab() {}, closeTab() {}, closeTabs() {}, dispatch() {},
                navigationForTab: () => ({ push() {}, replace() {}, back() {} }), registerBackStep: () => () => {}, back() {}, forward() {} }}>
                {children}
            </WorkspaceNavigationProvider>
        </PanePresentationProvider></AppPaneProvider> });
        await act(async () => { await waitForHomeGovernance(() => {
            expect(hook.getCurrent().pane.scopeState?.details.tabs).toEqual([expect.objectContaining({ key: 'file:a.ts', isPreview: true, isPinned: false })]);
        }); });
        expect(hook.getCurrent().track.target?.path).toBe('a.ts');
        expect(hrefs).toEqual([]);
        expect(present).not.toHaveBeenCalled();
        await hook.unmount();
    });
});
