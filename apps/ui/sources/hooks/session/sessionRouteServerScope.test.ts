import { describe, expect, it } from 'vitest';

import { buildScopedSessionRouteHref, createSessionRouteServerScope } from './sessionRouteServerScope';

describe('buildScopedSessionRouteHref', () => {
    it('opens an exact committed message without losing its Home or double interpreting its id', () => {
        expect(buildScopedSessionRouteHref({ sessionId: 'same/session', serverId: 'home-b',
            messageId: 'committed/answer?1' })).toBe('/session/same%2Fsession/message/server%3Acommitted%2Fanswer%3F1?serverId=home-b');
    });
    it('preserves the scoped serverId when query also contains serverId', () => {
        expect(buildScopedSessionRouteHref({
            sessionId: 'session-1',
            serverId: 'server-scoped',
            query: {
                serverId: 'server-overridden',
                tab: 'runs',
            },
        })).toBe('/session/session-1?serverId=server-scoped&tab=runs');
    });
});

describe('createSessionRouteServerScope legacy link admission', () => {
    const known = {
        sessionListIndexByServerId: {
            'home-a': [{ type: 'session' as const, sessionId: 'same', serverId: 'home-a' }],
            'https://b.example:8443/path': [{ type: 'session' as const, sessionId: 'same', serverId: 'https://b.example:8443/path' }],
        },
        ordinarySessionListMembershipByServerId: {
            'home-a': ['same'],
            'https://b.example:8443/path': ['same'],
        },
    };

    it('returns Which Home candidates without choosing a Home for an ambiguous legacy route', () => {
        const scope = createSessionRouteServerScope({ id: 'same' }, known);
        expect(scope.serverId).toBeNull();
        expect(scope.candidateAddresses).toEqual([
            { serverId: 'home-a', sessionId: 'same' },
            { serverId: 'https://b.example:8443/path', sessionId: 'same' },
        ]);
        expect(scope.hydrationOptions).toBeUndefined();
    });

    it('uses the one known Home for a legacy route', () => {
        const scope = createSessionRouteServerScope({ id: 'same' }, { sessions: { same: { serverId: 'home-a' } } });
        expect(scope.serverId).toBe('home-a');
        expect(scope.hydrationOptions).toEqual({ serverId: 'home-a' });
    });

    it('qualifies a cold route with the sole saved Home, deduplicating its scope ids', () => {
        const scope = createSessionRouteServerScope({ id: 'unloaded' }, {}, { homeServerIds: ['home-a', 'home-a'] });
        expect(scope.serverId).toBe('home-a');
        expect(scope.hydrationOptions).toEqual({ serverId: 'home-a' });
        expect(scope.candidateAddresses).toEqual([]);
    });

    it('keeps an unknown cold route unresolved when several Homes are saved', () => {
        const scope = createSessionRouteServerScope({ id: 'unloaded' }, {}, { homeServerIds: ['home-a', 'home-b'] });
        expect(scope.serverId).toBeNull();
        expect(scope.hydrationOptions).toBeUndefined();
    });

    it('does not qualify an invalid empty Session route merely because a sole Home is saved', () => {
        const scope = createSessionRouteServerScope({ id: ' ' }, {}, { homeServerIds: ['home-a'] });
        expect(scope.serverId).toBeNull();
        expect(scope.hydrationOptions).toBeUndefined();
    });

    it('does not let the sole saved Home override ambiguous Session membership', () => {
        const scope = createSessionRouteServerScope({ id: 'same' }, known, { homeServerIds: ['home-a'] });
        expect(scope.serverId).toBeNull();
        expect(scope.candidateAddresses).toHaveLength(2);
    });

    it('uses one current query-only Home for a legacy route', () => {
        const queryState = {
            requestedQueryKey: 'team-query', appliedQueryKey: 'team-query',
            addresses: [{ serverId: 'team-home', sessionId: 'team-only' }], phase: 'ready' as const,
        };
        const scope = createSessionRouteServerScope({ id: 'team-only' }, {
            sessionListRowsByServerId: { 'team-home': { 'team-only': {} } },
        }, { queryStates: [queryState] });
        expect(scope.serverId).toBe('team-home');
        expect(scope.hydrationOptions).toEqual({ serverId: 'team-home' });
    });

    it('keeps two current query memberships ambiguous', () => {
        const scope = createSessionRouteServerScope({ id: 'same' }, {}, { queryStates: [
            { requestedQueryKey: 'a', appliedQueryKey: 'a', addresses: [{ serverId: 'home-a', sessionId: 'same' }], phase: 'ready' },
            { requestedQueryKey: 'b', appliedQueryKey: 'b', addresses: [{ serverId: 'home-b', sessionId: 'same' }], phase: 'ready' },
        ] });
        expect(scope.serverId).toBeNull();
        expect(scope.candidateAddresses).toHaveLength(2);
    });

    it('ignores retained rows while current query membership is refreshing', () => {
        const scope = createSessionRouteServerScope({ id: 'stale' }, {
            sessionListRowsByServerId: { 'team-home': { stale: {} } },
            sessionListIndexByServerId: { 'team-home': [{ type: 'session', sessionId: 'stale' }] },
        }, { queryStates: [{
            requestedQueryKey: 'current-query', appliedQueryKey: 'current-query',
            addresses: [{ serverId: 'team-home', sessionId: 'stale' }], phase: 'refreshing',
        }] });
        expect(scope.serverId).toBeNull();
        expect(scope.candidateAddresses).toEqual([]);
    });

    it('ignores ready query membership applied for a previous query identity', () => {
        const scope = createSessionRouteServerScope({ id: 'stale' }, {}, { queryStates: [{
            requestedQueryKey: 'new-query', appliedQueryKey: 'old-query',
            addresses: [{ serverId: 'team-home', sessionId: 'stale' }], phase: 'ready',
        }] });
        expect(scope.candidateAddresses).toEqual([]);
    });

    it('accepts exact qualification without enumerating unrelated Homes', () => {
        const scope = createSessionRouteServerScope({ id: 'same', serverId: 'https://b.example:8443/path' }, {
            get sessionListIndexByServerId(): never { throw new Error('Exact qualification must not enumerate'); },
        });
        expect(scope.buildHref('same')).toBe('/session/same?serverId=https%3A%2F%2Fb.example%3A8443%2Fpath');
        expect(scope.candidateAddresses).toEqual([]);
    });
});
