import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createDeferred, createSessionFixture } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { storage } from '@/sync/domains/state/storage';
import { upsertServerProfile, setActiveServerId, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { resetRuntimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { sessionArchiveWithServerScope, sessionUnarchiveWithServerScope } from '../../ops';

const sessionId = 'same_session_id';
const response = (archivedAt: number | null) => new Response(JSON.stringify({ success: true, archivedAt }));

function cachedSession(serverId: string) {
    return storage.getState().sessionListViewDataByServerId[serverId]
        ?.find((item) => item.type === 'session' && item.session.id === sessionId);
}

function seedActiveSession(archivedAt: number | null = null) {
    storage.getState().applySessions([createSessionFixture({ id: sessionId, archivedAt, owner: 'account-a' })]);
}

function seedRemoteSession(serverId: string, archivedAt: number | null = null) {
    const item = storage.getState().sessionListViewData?.find((entry) => entry.type === 'session');
    if (!item || item.type !== 'session') throw new Error('Expected a real store session-list projection');
    storage.setState((state) => ({
        sessionListViewDataByServerId: {
            ...state.sessionListViewDataByServerId,
            [serverId]: [{ ...item, serverId, session: { ...item.session, archivedAt } }],
        },
    }));
}

describe('server-scoped session archive operations', () => {
    let serverA: ServerProfile;
    let serverB: ServerProfile;
    let activeRequest: MockInstance<typeof apiSocket.request>;
    const remoteRequest = vi.fn(async () => response(42));

    beforeEach(() => {
        storage.setState(storage.getInitialState(), true);
        serverA = upsertServerProfile({ serverUrl: 'https://archive-a.example' });
        serverB = upsertServerProfile({ serverUrl: 'https://archive-b.example' });
        setActiveServerId(serverA.id);
        activeRequest = vi.spyOn(apiSocket, 'request').mockImplementation(async () => response(42));
        // Credentials and transport are external boundaries; resolution and all store projections stay real.
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({
            token: 'header.eyJzdWIiOiJhY2NvdW50LWEifQ.signature',
        });
        remoteRequest.mockReset();
        remoteRequest.mockImplementation(async () => response(42));
        setRuntimeFetch(remoteRequest);
        seedActiveSession();
    });
    afterEach(() => {
        resetRuntimeFetch();
        vi.restoreAllMocks();
    });

    it('archives the active session through the socket transport and patches its real store projection', async () => {
        await expect(sessionArchiveWithServerScope(sessionId, { serverId: serverA.id }))
            .resolves.toMatchObject({ success: true, archivedAt: 42 });
        expect(activeRequest).toHaveBeenCalledWith(`/v2/sessions/${sessionId}/archive`, { method: 'POST' });
        expect(storage.getState().sessions[sessionId]?.archivedAt).toBe(42);
        expect(storage.getState().sessionListRenderables[sessionId]?.archivedAt).toBe(42);
        expect(remoteRequest).not.toHaveBeenCalled();
    });

    it.each(['archive', 'unarchive'] as const)('projects a remote %s into its own cache without touching a same-id active session', async (action) => {
        const before = action === 'archive' ? null : 10;
        const after = action === 'archive' ? 42 : null;
        seedRemoteSession(serverB.id, before);
        remoteRequest.mockImplementation(async () => response(after));
        const activeSession = storage.getState().sessions[sessionId];
        const activeRenderable = storage.getState().sessionListRenderables[sessionId];
        const run = action === 'archive' ? sessionArchiveWithServerScope : sessionUnarchiveWithServerScope;
        await expect(run(sessionId, { serverId: serverB.id })).resolves.toMatchObject({ success: true });
        const remote = cachedSession(serverB.id);
        expect(remote?.type === 'session' ? remote.session.archivedAt : undefined).toBe(after);
        expect(storage.getState().sessions[sessionId]).toBe(activeSession);
        expect(storage.getState().sessionListRenderables[sessionId]).toBe(activeRenderable);
        expect(activeRequest).not.toHaveBeenCalled();
        expect(remoteRequest).toHaveBeenCalledWith(expect.stringContaining(`/v2/sessions/${sessionId}/${action}`), expect.any(Object));
    });

    it('settles a request against its original server after the active server changes', async () => {
        const network = createDeferred<Response>();
        activeRequest.mockReturnValueOnce(network.promise);
        const firstSession = storage.getState().sessions[sessionId];
        const result = sessionArchiveWithServerScope(sessionId, { serverId: serverA.id });
        await vi.waitFor(() => expect(activeRequest).toHaveBeenCalledTimes(1));
        setActiveServerId(serverB.id);
        const secondSession = createSessionFixture({ id: sessionId, archivedAt: null, owner: 'account-b' });
        storage.setState({
            sessions: { [sessionId]: secondSession },
            sessionListRenderables: { [sessionId]: buildSessionListRenderableFromSession(secondSession) },
        });
        network.resolve(response(42));
        await expect(result).resolves.toMatchObject({ success: true });
        expect(storage.getState().sessions[sessionId]).toBe(secondSession);
        expect(storage.getState().sessionListRenderables[sessionId]?.archivedAt).toBeNull();
        const first = cachedSession(serverA.id);
        expect(first?.type === 'session' ? first.session.archivedAt : undefined).toBe(42);
        expect(firstSession.archivedAt).toBeNull();
    });

    it.each(['archive', 'unarchive'] as const)('updates a cache-only active renderable after %s', async (action) => {
        storage.setState({ sessions: {} });
        activeRequest.mockImplementation(async () => response(action === 'archive' ? 42 : null));
        const run = action === 'archive' ? sessionArchiveWithServerScope : sessionUnarchiveWithServerScope;
        await expect(run(sessionId, { serverId: serverA.id })).resolves.toMatchObject({ success: true });
        expect(storage.getState().sessionListRenderables[sessionId]?.archivedAt).toBe(action === 'archive' ? 42 : null);
    });

    it('preserves local state and returns the stable session_active conflict code', async () => {
        const before = storage.getState().sessions[sessionId];
        activeRequest.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'session-active' }), { status: 409 }));
        await expect(sessionArchiveWithServerScope(sessionId)).resolves.toMatchObject({ success: false, code: 'session_active' });
        expect(storage.getState().sessions[sessionId]).toBe(before);
    });
});
