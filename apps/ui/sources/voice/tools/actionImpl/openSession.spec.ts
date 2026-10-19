import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextType } from '@/auth/context/AuthContext';
import { createSessionFixture } from '@/dev/testkit';

const fixtureMetadata = (() => {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('Canonical Session fixture metadata missing');
    return metadata;
})();
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const routerNavigate = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    router: { navigate: routerNavigate },
}).module);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getCurrentAuth, setCurrentAuth } = await import('@/auth/context/currentAuth');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const { openSessionForVoiceTool } = await import('./openSession');
const initialState = storage.getState();
const initialTargets = useVoiceTargetStore.getState();
let previousAuth: AuthContextType | null;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let a: string;
let b: string;

beforeEach(async () => {
    await home.reset();
    storage.setState(initialState, true);
    useVoiceTargetStore.setState(useVoiceTargetStore.getInitialState(), true);
    a = await home.addHome({ name: 'Server A', serverUrl: 'https://voice-open-a.test', accountId: 'account-a' });
    b = await home.addHome({ name: 'Server B', serverUrl: 'https://voice-open-b.test', accountId: 'account-b', active: false });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://voice-open-a.test', accountId: 'account-a',
        request: async (url, init) => home.request(url, init),
    });
    installHomeGovernanceBoundaries(home);
    previousAuth = getCurrentAuth();
    setCurrentAuth({
        isAuthenticated: true, credentials: connection.credentials, credentialAuthorityKind: 'account',
        login: async () => ({ kind: 'completed' }), loginWithCredentials: async () => ({ kind: 'completed' }),
        logout: async () => ({ kind: 'completed' }), refreshFromActiveServer: async () => {},
    });
    const setup = createSessionFixture({ id: 's_setup', serverId: a,
        metadata: { ...fixtureMetadata, summary: { text: 'Session Setup', updatedAt: 1 } } });
    const matrix = createSessionFixture({ id: 's_matrix', serverId: a,
        metadata: { ...fixtureMetadata, name: 'leeroy' } });
    storage.setState({
        sessions: { s_setup: setup, s_matrix: matrix },
        sessionListRowsByServerId: {
            [a]: {
                s_visible: buildSessionListRenderableFromSession(createSessionFixture({ id: 's_visible', serverId: a, updatedAt: 321,
                    metadata: { ...fixtureMetadata, summaryText: 'Visible only in current list' } })),
                s_matrix: buildSessionListRenderableFromSession(createSessionFixture({ id: 's_matrix', serverId: a, updatedAt: 322,
                    metadata: { ...fixtureMetadata, summaryText: 'Session QA Voice Matrix' } })),
            },
            [b]: { s_other: buildSessionListRenderableFromSession(createSessionFixture({ id: 's_other', serverId: b,
                metadata: { ...fixtureMetadata, summary: { text: 'Other summary', updatedAt: 1 } } })) },
        },
        ordinarySessionListMembershipByServerId: { [a]: ['s_visible', 's_matrix'], [b]: ['s_other'] },
        sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: { [b]: { serverName: 'Server B' } },
    });
    routerNavigate.mockClear();
});
afterEach(async () => {
    setCurrentAuth(previousAuth);
    await connection.dispose();
    await home.reset();
    storage.setState(initialState, true);
    useVoiceTargetStore.setState(initialTargets, true);
});

describe('openSessionForVoiceTool', () => {
    it('opens the exact session through the mounted workspace owner for an imperative Voice tool', async () => {
        const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
        const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
        const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
        let workspace = createWorkspaceState({ id: 'voice-tool-tab', target: { kind: 'voice', params: {} }, pinned: false, preview: false });
        const navigation = createWorkspaceNavigationAdapter({
            getState: () => workspace, getCatalog: () => [],
            dispatch: action => { workspace = reduceWorkspaceState(workspace, action); },
            transport: { commit: () => {} }, createId: () => 'voice-session-tab', onChange: () => {},
        });
        const execute = createWorkspaceActionAdapter({ getState: () => workspace, navigation, readCanvas: () => null, createId: () => 'voice-session-tab' });
        const unregister = registerMountedWorkspaceAction(async ({ actionId, input }) => execute(actionId, input));
        try {
            expect(await openSessionForVoiceTool({ sessionId: 's_setup', serverId: a, query: { jumpSeq: '42' } }))
                .toMatchObject({ ok: true, address: { serverId: a, sessionId: 's_setup' } });
            const group = workspace.groups[workspace.focusedGroupId];
            expect(workspace.tabs[group.activeTabId].target).toMatchObject({ kind: 'session', params: { id: 's_setup', serverId: a, jumpSeq: '42' } });
            expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: a, sessionId: 's_setup' });
            expect(routerNavigate).not.toHaveBeenCalled();
        } finally { unregister(); }
    });
    it('returns a human-readable session reference after actually switching to the cached cross-server Home', async () => {
        const result = await openSessionForVoiceTool({ sessionId: 's_other',
            resolveServerIdForSessionId: () => b, resolveServerNameForSessionId: () => 'Server B',
        });
        expect(getActiveServerSnapshot().serverId).toBe(b);
        expect(routerNavigate).toHaveBeenCalledWith(`/session/s_other?serverId=${b}`, expect.any(Object));
        expect(result).toMatchObject({ ok: true, sessionId: 's_other', session: {
            id: 's_other', title: 'Other summary', serverId: b, serverName: 'Server B',
        } });
        expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: b, sessionId: 's_other' });
    });
    it('fails without mutating Voice targets when the target Home credential store refuses the switch', async () => {
        const readCredentials = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
        const credentials = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async serverUrl => {
            if (new URL(serverUrl).origin === 'https://voice-open-b.test') throw new Error('Target Home credential storage unavailable');
            return readCredentials(serverUrl);
        });
        try {
            const result = await openSessionForVoiceTool({ sessionId: 's_other',
                resolveServerIdForSessionId: () => b, resolveServerNameForSessionId: () => 'Server B',
            });
            expect(getActiveServerSnapshot().serverId).toBe(a);
            expect(routerNavigate).not.toHaveBeenCalled();
            expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toBeNull();
            expect(useVoiceTargetStore.getState().lastFocusedSessionAddress).toBeNull();
            expect(result).toEqual({ ok: false, status: 'server_switch_failed', error: {
                code: 'server_switch_failed', message: 'server_switch_failed', serverId: b, serverName: 'Server B',
            } });
        } finally {
            credentials.mockRestore();
        }
    });
    it('opens a session by human title and ignores trailing sentence punctuation', async () => {
        const result = await openSessionForVoiceTool({ sessionTitle: 'Session Setup.',
            corpus: { activeServerId: a, knownServerIds: [a], coverage: 'complete' },
        });
        expect(getActiveServerSnapshot().serverId).toBe(a);
        expect(routerNavigate).toHaveBeenCalledWith(`/session/s_setup?serverId=${a}`, expect.any(Object));
        expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: a, sessionId: 's_setup' });
        expect(result).toMatchObject({ ok: true, sessionId: 's_setup', session: { id: 's_setup', title: 'Session Setup' } });
    });
    it('opens a session by title when the lookup title lives on metadata.summaryText', async () => {
        const result = await openSessionForVoiceTool({ sessionTitle: 'Session QA Voice Matrix',
            corpus: { activeServerId: a, knownServerIds: [a], coverage: 'complete' },
        });
        expect(routerNavigate).toHaveBeenCalledWith(`/session/s_matrix?serverId=${a}`, expect.any(Object));
        expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: a, sessionId: 's_matrix' });
        expect(result).toMatchObject({ ok: true, sessionId: 's_matrix', session: { id: 's_matrix', title: 'Session QA Voice Matrix' } });
    });
    it('prefers the current visible session title over a stale raw session title for the same session id', async () => {
        storage.setState(current => ({ sessions: { ...current.sessions, s_matrix: createSessionFixture({ id: 's_matrix', serverId: a,
            metadata: { ...fixtureMetadata, summaryText: 'Session QA Voice Matrix!' } }),
        } }));
        const result = await openSessionForVoiceTool({ sessionTitle: 'Session QA Voice Matrix',
            corpus: { activeServerId: a, knownServerIds: [a], coverage: 'complete' },
        });
        expect(routerNavigate).toHaveBeenCalledWith(`/session/s_matrix?serverId=${a}`, expect.any(Object));
        expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: a, sessionId: 's_matrix' });
        expect(result).toMatchObject({ ok: true, sessionId: 's_matrix', session: { id: 's_matrix', title: 'Session QA Voice Matrix' } });
    });
    it('opens a session by title when the session only exists in the active session lookup index', async () => {
        const result = await openSessionForVoiceTool({ sessionTitle: 'Visible only in current list',
            corpus: { activeServerId: a, knownServerIds: [a], coverage: 'complete' },
        });
        expect(routerNavigate).toHaveBeenCalledWith(`/session/s_visible?serverId=${a}`, expect.any(Object));
        expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: a, sessionId: 's_visible' });
        expect(result).toMatchObject({ ok: true, sessionId: 's_visible', session: { id: 's_visible', title: 'Visible only in current list' } });
    });
    it('publishes the canonical primary and last-focused target while opening the exact session', async () => {
        await openSessionForVoiceTool({ sessionId: 's_setup', serverId: a });
        expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: a, sessionId: 's_setup' });
        expect(useVoiceTargetStore.getState().lastFocusedSessionAddress).toEqual({ serverId: a, sessionId: 's_setup' });
    });
});
