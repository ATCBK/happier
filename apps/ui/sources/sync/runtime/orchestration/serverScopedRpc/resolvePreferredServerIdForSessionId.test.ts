import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storage';

const getActiveServerSnapshotMock = vi.hoisted(() => vi.fn(() => ({ serverId: 'active-server' })));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    subscribeActiveServer: () => () => {},
    getActiveServerSnapshot: () => getActiveServerSnapshotMock(),
}));

const initialState = storage.getState();

function createSession(id: string, serverId?: string) {
    return {
        id,
        serverId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        pendingVersion: 1,
        pendingCount: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
    };
}

function createRenderableSession(id: string, serverId: string) {
    return buildSessionListRenderableFromSession(createSession(id, serverId));
}

describe('resolvePreferredServerIdForSessionId', () => {
    beforeEach(() => {
        getActiveServerSnapshotMock.mockReset();
        getActiveServerSnapshotMock.mockReturnValue({ serverId: 'active-server' });
        storage.setState(initialState, true);
    });

    afterEach(() => {
        storage.setState(initialState, true);
    });

    it('prefers the locally resolved owning server for a known session', async () => {
        const session = createSession('session-1', 'owner-server');
        storage.setState((state) => ({
            ...state,
            sessions: {
                'session-1': session,
            },
            // The row corpus is Home-scoped, so a Session owned by `owner-server`
            // is projected there. Duplicating it under the focused Home would be
            // the two-Home collision the fail-closed case below covers.
            sessionListRowsByServerId: {
                'owner-server': {
                    'session-1': createRenderableSession('session-1', 'owner-server'),
                },
            },
            ordinarySessionListMembershipByServerId: { 'owner-server': ['session-1'] },
            sessionListIndexByServerId: {
                'owner-server': [
                    {
                        type: 'session',
                        sessionId: 'session-1',
                        serverId: 'owner-server',
                        serverName: 'Owner',
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBe('owner-server');
    });

    it('falls back to the active server when the owning server is unknown', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionListRowsByServerId: {
                'active-server': {
                    'session-1': createRenderableSession('session-1', 'active-server'),
                },
            },
            ordinarySessionListMembershipByServerId: { 'active-server': ['session-1'] },
            sessionListIndexByServerId: {
                'active-server': [
                    {
                        type: 'session',
                        sessionId: 'session-1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBe('active-server');
    });

    it('ignores a stale canonical row without authoritative membership', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionListRowsByServerId: {
                'active-server': {
                    'session-1': createRenderableSession('session-1', 'active-server'),
                },
            },
            ordinarySessionListMembershipByServerId: {},
            sessionListIndexByServerId: {},
            concurrentSessionListCacheByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBeUndefined();
    });

    it('fails closed when the same bare session id is projected by two Homes', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {
                'session-1': createSession('session-1', 'active-server'),
            },
            sessionListRowsByServerId: {
                'active-server': {
                    'session-1': createRenderableSession('session-1', 'active-server'),
                },
                'owner-server': {
                    'session-1': createRenderableSession('session-1', 'owner-server'),
                },
            },
            ordinarySessionListMembershipByServerId: {
                'active-server': ['session-1'],
                'owner-server': ['session-1'],
            },
            sessionListIndexByServerId: {
                'active-server': [
                    {
                        type: 'session',
                        sessionId: 'session-1',
                        serverId: 'active-server',
                        serverName: 'Active',
                    },
                ],
            },
            concurrentSessionListCacheByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBeUndefined();
    });

    it('returns undefined when the session cannot be resolved to any cached server', async () => {
        storage.setState((state) => ({
            ...state,
            sessions: {},
            sessionListIndexByServerId: {
                'active-server': [],
            },
            concurrentSessionListCacheByServerId: {},
        }), true);

        const { resolvePreferredServerIdForSessionId } = await import('./resolvePreferredServerIdForSessionId');

        expect(resolvePreferredServerIdForSessionId('session-1')).toBeUndefined();
    });
});
