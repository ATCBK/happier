import { describe, expect, it } from 'vitest';
import { createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import {
    findSessionListLookupSession,
    listSessionListLookupActiveSessionIds,
    listSessionListLookupActiveSessions,
    listSessionListLookupServerSessions,
    listSessionListLookupServers,
    resolveSessionListLookupSessionServerScopeFromState,
    resolveSessionListLookupSessionServerId,
    resolveSessionListPreferredServerIdFromState,
    resolveSessionListPreferredSessionMetadataFromState,
    type SessionServerLookupStateLike,
} from './sessionListLookupState';

const row = (id: string, name = id) => createSessionListRenderableSessionFixture({
    id, metadata: { name, path: '/project' },
});

describe('sessionListLookupState', () => {
    it('reads metadata for 1000 real-store rows without visiting their presentation index', async () => {
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { upsertServerProfile, removeServerProfile } = await import('@/sync/domains/server/serverProfiles');
        const previousState = storage.getState();
        const profile = await upsertServerProfile({ serverUrl: 'https://metadata-read-cost.example.test', name: 'Metadata read cost' });
        const rows = Array.from({ length: 1_000 }, (_, index) => row(`metadata-cost-${index}`));
        let indexVisits = 0;
        const index = rows.map(session => ({
            type: 'session' as const,
            serverId: profile.id,
            get sessionId() { indexVisits += 1; return session.id; },
        }));
        try {
            storage.setState({
                sessions: {},
                sessionListRowsByServerId: { [profile.id]: Object.fromEntries(rows.map(session => [session.id, session])) },
                sessionListIndexByServerId: { [profile.id]: index },
            });
            for (const session of rows) {
                expect(resolveSessionListPreferredSessionMetadataFromState(storage.getState(), {
                    serverId: profile.id, sessionId: session.id,
                })).toBe(session.metadata);
            }
            // Metadata already lives in the keyed row owner. Presentation labels
            // have no reader in this operation, regardless of corpus size.
            expect(indexVisits).toBe(0);
        } finally {
            storage.setState(previousState, true);
            await removeServerProfile(profile.id);
        }
    });

    it('looks up the exact qualified row and never borrows the active Home metadata', () => {
        const a = row('same', 'A');
        const b = row('same', 'B');
        const state = {
            sessionListRowsByServerId: { 'home-a': { same: a }, 'https://b.example:8443': { same: b } },
        };
        expect(findSessionListLookupSession(state, { serverId: 'home-a', sessionId: 'same' })?.session).toBe(a);
        expect(findSessionListLookupSession(state, { serverId: 'https://b.example:8443', sessionId: 'same' })?.session).toBe(b);
        expect(findSessionListLookupSession(state, { serverId: 'missing', sessionId: 'same' })).toBeNull();
        expect(findSessionListLookupSession(state, 'same')).toBeNull();
        expect(resolveSessionListPreferredServerIdFromState(state, 'same', 'home-a')).toBeNull();
        expect(resolveSessionListPreferredSessionMetadataFromState(state, { serverId: 'https://b.example:8443', sessionId: 'same' })).toBe(b.metadata);
    });

    it('ignores index-only rows when adapting a legacy unqualified lookup', () => {
        const state = {
            sessions: { same: { serverId: 'home-a' } },
            sessionListIndexByServerId: {
                'home-b': [{ type: 'session', sessionId: 'same', serverId: 'home-b', serverName: 'B' }],
            },
        } satisfies SessionServerLookupStateLike;
        expect(resolveSessionListLookupSessionServerId(state, 'same')).toBe('home-a');
        expect(resolveSessionListLookupSessionServerScopeFromState(state, 'same'))
            .toEqual({ serverId: 'home-a', serverName: null });
        expect(resolveSessionListPreferredSessionMetadataFromState(state, 'same')).toBeNull();
        expect(resolveSessionListPreferredServerIdFromState(state, 'missing', 'home-a')).toBeNull();
        expect(resolveSessionListLookupSessionServerScopeFromState(state, { serverId: 'home-b', sessionId: 'same' }))
            .toEqual({ serverId: 'home-b', serverName: 'B' });
    });

    it('adapts one known legacy address without a focus fallback or stale bare-id memo', () => {
        const state = {
            sessionListIndexByServerId: {
                'home-a': [{ type: 'session', sessionId: 'same', serverId: 'home-a', serverName: 'A' }],
            },
            sessionListRowsByServerId: { 'home-a': { same: row('same') } },
            ordinarySessionListMembershipByServerId: { 'home-a': ['same'] },
            concurrentSessionListCacheByServerId: {
                'home-a': { serverName: 'A' },
            },
        } satisfies SessionServerLookupStateLike;
        expect(resolveSessionListPreferredServerIdFromState(state, ' same ', 'home-b')).toBe('home-a');
        expect(findSessionListLookupSession(state, 'same')?.session).toBe(state.sessionListRowsByServerId['home-a'].same);
        const next = {
            ...state,
            sessionListIndexByServerId: {
                ...state.sessionListIndexByServerId,
                'home-b': [{ type: 'session' as const, sessionId: 'same', serverId: 'home-b' }],
            },
        };
        expect(findSessionListLookupSession(next, 'same')?.session)
            .toBe(state.sessionListRowsByServerId['home-a'].same);
    });

    it('reads canonical active-Home membership in order and does not substitute a populated secondary Home', () => {
        const serverId = getActiveServerSnapshot().serverId;
        const a = row('one');
        const b = row('two');
        const state = {
            sessionListIndexByServerId: {
                [serverId]: [
                    { type: 'session', sessionId: 'two', serverId },
                    { type: 'session', sessionId: 'one', serverId },
                ],
                other: [{ type: 'session', sessionId: 'other', serverId: 'other' }],
            },
            sessionListRowsByServerId: { [serverId]: { one: a, two: b } },
            ordinarySessionListMembershipByServerId: { [serverId]: ['two', 'one'] },
        } satisfies SessionServerLookupStateLike;
        expect(listSessionListLookupActiveSessions(state).map((entry) => entry.session)).toEqual([b, a]);
        expect(listSessionListLookupActiveSessionIds(state, 1)).toEqual(['two']);
        expect(listSessionListLookupActiveSessionIds(state, 0)).toEqual([]);
        expect(listSessionListLookupActiveSessions({
            ...state,
            ordinarySessionListMembershipByServerId: {
                ...state.ordinarySessionListMembershipByServerId,
                [serverId]: [],
                other: ['other'],
            },
        })).toEqual([]);
    });

    it('prefers the canonical row and merges missing machine identity only within its Home', () => {
        const cached = row('same', 'Fresh title');
        const state = {
            sessions: { same: { serverId: 'home-a', metadata: { name: 'Old title', machineId: 'machine-a' } } },
            sessionListRowsByServerId: { 'home-a': { same: cached }, 'home-b': { same: row('same', 'B title') } },
        };
        expect(resolveSessionListPreferredSessionMetadataFromState(state, { serverId: 'home-a', sessionId: 'same' }))
            .toEqual({ ...cached.metadata, machineId: 'machine-a' });
        expect(resolveSessionListPreferredSessionMetadataFromState(state, { serverId: 'home-b', sessionId: 'same' }))
            .toEqual({ name: 'B title', path: '/project' });
    });

    it('reads metadata from an exactly qualified full entity without inventing a list row', () => {
        const metadata = { name: 'Direct' };
        const state = { sessions: { direct: { serverId: 'home-a', metadata } } };
        expect(resolveSessionListPreferredSessionMetadataFromState(state, 'direct')).toBe(metadata);
        expect(findSessionListLookupSession(state, 'direct')).toBeNull();
        expect(resolveSessionListPreferredSessionMetadataFromState(state, { serverId: 'home-b', sessionId: 'direct' })).toBeNull();
    });

    it('enumerates canonical ordinary membership without admitting query-only rows', () => {
        const a = row('same', 'A');
        const b = row('same', 'B');
        const queryOnly = row('query-only', 'Query only');
        const state = {
            sessionListRowsByServerId: {
                'home-a': { same: a, 'query-only': queryOnly },
                'home-b': { same: b },
            },
            ordinarySessionListMembershipByServerId: {
                'home-a': ['same'],
                'home-b': ['same'],
                empty: [],
            },
            concurrentSessionListCacheByServerId: {
                'home-a': { serverName: 'A' },
                'home-b': { serverName: 'B' },
                empty: { serverName: 'Empty' },
            },
        };
        expect(listSessionListLookupServerSessions(state)).toEqual([
            { serverId: 'home-a', serverName: 'A', session: a },
            { serverId: 'home-b', serverName: 'B', session: b },
        ]);
        expect(listSessionListLookupServers(state)).toEqual([
            { serverId: 'home-a', serverName: 'A' }, { serverId: 'home-b', serverName: 'B' },
        ]);
        expect(findSessionListLookupSession(state, { serverId: 'home-b', sessionId: 'same' })?.session).toBe(b);
        expect(findSessionListLookupSession(state, 'same')).toBeNull();
    });

    it('reuses shared empty arrays for absent membership', () => {
        expect(listSessionListLookupActiveSessions(null)).toBe(listSessionListLookupActiveSessions(undefined));
        expect(listSessionListLookupActiveSessionIds(null)).toBe(listSessionListLookupActiveSessionIds(undefined));
        expect(listSessionListLookupServerSessions(null)).toBe(listSessionListLookupServerSessions(undefined));
        expect(listSessionListLookupServers(null)).toBe(listSessionListLookupServers(undefined));
    });
});
