import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReplaceSessionVoiceInclusionsRequestSchema, ReplaceSessionVoiceInclusionsResponseSchema, SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit';

const fixtureMetadata = (() => {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('Canonical Session fixture metadata missing');
    return metadata;
})();
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { useVoiceTargetStore } = await import('@/voice/runtime/voiceTargetStore');
const { setPrimaryActionSessionId, setTrackedSessionIds } = await import('./sessionTargets');
const initialState = storage.getState();
const initialTargets = useVoiceTargetStore.getState();
const persistedInclusions = new Map<string, readonly string[]>();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let a: string;
let b: string;

function corpus(addresses: readonly { serverId: string; sessionId: string }[], knownServerIds: readonly string[] = [a]) {
    return { knownServerIds, addresses, coverage: 'complete' as const };
}
function replacementRequests() {
    return home.requestsFor(SESSION_FOLLOW_HTTP_PATHS_V1.voiceInclusions).map(request => ({
        serverId: request.serverId,
        sessionIds: ReplaceSessionVoiceInclusionsRequestSchema.parse(request.input).sessionIds,
    }));
}
function includeProjection(serverId: string, sessionId: string) {
    const row = buildSessionListRenderableFromSession(createSessionFixture({ id: sessionId, serverId,
        viewer: createSessionViewerFixture({ follow: { follows: true, notificationLevel: 'all_messages', includeInVoice: true } }),
    }));
    storage.setState(current => ({
        sessionListRowsByServerId: { ...current.sessionListRowsByServerId,
            [serverId]: { ...current.sessionListRowsByServerId[serverId], [sessionId]: row } },
        ordinarySessionListMembershipByServerId: { ...current.ordinarySessionListMembershipByServerId, [serverId]: [sessionId] },
    }));
    persistedInclusions.set(serverId, [sessionId]);
}
beforeEach(async () => {
    await home.reset();
    storage.setState(initialState, true);
    useVoiceTargetStore.setState(useVoiceTargetStore.getInitialState(), true);
    const first = await home.addHome({ name: 'A', serverUrl: 'https://voice-targets-a.test', accountId: 'account-a' });
    const second = await home.addHome({ name: 'B', serverUrl: 'https://voice-targets-b.test', accountId: 'account-b', active: false });
    const ids = [first, second];
    [a, b] = ids.sort();
    persistedInclusions.clear();
    for (const serverId of [a, b]) home.answer(serverId, `PUT ${SESSION_FOLLOW_HTTP_PATHS_V1.voiceInclusions}`, {
        select: input => {
            const { sessionIds } = ReplaceSessionVoiceInclusionsRequestSchema.parse(input);
            persistedInclusions.set(serverId, sessionIds);
            return { body: ReplaceSessionVoiceInclusionsResponseSchema.parse({ changed: true, sessionIds }) };
        },
    });
    const profile = getServerProfileById(a);
    if (!profile) throw new Error('Target Home fixture missing');
    const accountId = home.findByServerUrl(profile.serverUrl)?.accountId;
    if (!accountId) throw new Error('Target Account fixture missing');
    connection = await restoreServerAccountForTest({ serverUrl: profile.serverUrl, accountId,
        request: async (url, init) => home.request(url, init),
    });
    installHomeGovernanceBoundaries(home);
    const sessions = Object.fromEntries([
        ['s1', 'Primary session'], ['s2', 'Tracked session'], ['s3', 'Session Setup'], ['s4', 'leeroy'],
    ].map(([id, title]) => [id!, createSessionFixture({ id: id!, serverId: a,
        metadata: { ...fixtureMetadata, summary: { text: title!, updatedAt: 1 } } })]));
    storage.setState({
        sessions,
        sessionListRowsByServerId: { [a]: {
            s4: buildSessionListRenderableFromSession(createSessionFixture({ id: 's4', serverId: a, updatedAt: 10,
                metadata: { ...fixtureMetadata, summaryText: 'Session QA Voice Matrix' } })),
        } },
        ordinarySessionListMembershipByServerId: { [a]: ['s4'] },
        sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
    });
});
afterEach(async () => {
    await connection.dispose();
    await home.reset();
    vi.restoreAllMocks();
    storage.setState(initialState, true);
    useVoiceTargetStore.setState(initialTargets, true);
});

describe('voice session target actions', () => {
    it('publishes the exact qualified primary target and its stored title', async () => {
        const result = await setPrimaryActionSessionId({ sessionId: 's2', serverId: a });
        expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: a, sessionId: 's2' });
        expect(result).toMatchObject({ ok: true, sessionId: 's2', session: { id: 's2', title: 'Tracked session' } });
    });
    it('returns tracked session labels using the normalized stored ordering', async () => {
        const result = await setTrackedSessionIds({ sessionIds: ['s2', ' s1 ', 's2'], serverId: a,
            corpus: corpus([{ serverId: a, sessionId: 's1' }, { serverId: a, sessionId: 's2' }]),
        });
        expect(result).toMatchObject({ ok: true, sessionIds: ['s1', 's2'], sessions: [
            { id: 's1', title: 'Primary session' }, { id: 's2', title: 'Tracked session' },
        ] });
        expect(persistedInclusions.get(a)).toEqual(['s1', 's2']);
    });
    it('adapts the released tracked-set action to qualified Account Follow Include in Voice preferences', async () => {
        includeProjection(a, 's1');
        const result = await setTrackedSessionIds({ sessionIds: ['s2'], serverId: a,
            corpus: corpus([{ serverId: a, sessionId: 's1' }, { serverId: a, sessionId: 's2' }]),
        });
        expect(result).toMatchObject({ ok: true, sessionAddresses: [{ serverId: a, sessionId: 's2' }] });
        expect(replacementRequests()).toEqual([{ serverId: a, sessionIds: ['s2'] }]);
        expect(persistedInclusions.get(a)).toEqual(['s2']);
    });
    it('publishes only the effective Voice inclusions returned by the Home', async () => {
        home.answer(a, `PUT ${SESSION_FOLLOW_HTTP_PATHS_V1.voiceInclusions}`, {
            body: ReplaceSessionVoiceInclusionsResponseSchema.parse({ changed: true, sessionIds: [] }),
        });
        const result = await setTrackedSessionIds({ sessionIds: ['s2'], serverId: a,
            corpus: corpus([{ serverId: a, sessionId: 's2' }]),
        });
        expect(result).toMatchObject({ ok: true, sessionIds: [], sessionAddresses: [], sessions: [] });
        expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual([]);
    });
    it('replaces the synchronized Include in Voice set after an attempt-local restart', async () => {
        includeProjection(a, 's1');
        expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual([]);
        await expect(setTrackedSessionIds({ sessionIds: [], serverId: a, corpus: corpus([{ serverId: a, sessionId: 's1' }]) }))
            .resolves.toMatchObject({ ok: true, sessionAddresses: [] });
        expect(replacementRequests()).toEqual([{ serverId: a, sessionIds: [] }]);
        expect(persistedInclusions.get(a)).toEqual([]);
    });
    it('clears omitted Homes when replacing the complete global Include in Voice set', async () => {
        includeProjection(a, 'a');
        includeProjection(b, 'b');
        const result = await setTrackedSessionIds({ sessionAddresses: [{ serverId: a, sessionId: 'a' }],
            corpus: corpus([{ serverId: a, sessionId: 'a' }, { serverId: b, sessionId: 'b' }], [a, b]),
        });
        expect(result).toMatchObject({ ok: true, sessionAddresses: [{ serverId: a, sessionId: 'a' }] });
        expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual([{ serverId: a, sessionId: 'a' }]);
        expect(replacementRequests()).toEqual([{ serverId: a, sessionIds: ['a'] }, { serverId: b, sessionIds: [] }]);
        expect(persistedInclusions.get(b)).toEqual([]);
    });
    it('clears every authoritatively known Home for an empty global replacement', async () => {
        includeProjection(a, 'a');
        includeProjection(b, 'b');
        await expect(setTrackedSessionIds({ sessionAddresses: [],
            corpus: corpus([{ serverId: a, sessionId: 'a' }, { serverId: b, sessionId: 'b' }], [a, b]),
        })).resolves.toMatchObject({ ok: true, sessionAddresses: [] });
        expect(replacementRequests()).toEqual([{ serverId: a, sessionIds: [] }, { serverId: b, sessionIds: [] }]);
        expect(persistedInclusions.get(a)).toEqual([]);
        expect(persistedInclusions.get(b)).toEqual([]);
    });
    it('refuses global replacement when current Include in Voice coverage is incomplete', async () => {
        await expect(setTrackedSessionIds({ sessionAddresses: [{ serverId: a, sessionId: 's1' }],
            corpus: { knownServerIds: [a, b], addresses: [{ serverId: a, sessionId: 's1' }], coverage: 'incomplete' },
        })).resolves.toMatchObject({ ok: false, status: 'incomplete', error: { code: 'session_lookup_incomplete' } });
        expect(replacementRequests()).toEqual([]);
    });
    it('keeps equal Session ids on different Homes distinct in the compatibility adapter', async () => {
        const addresses = [{ serverId: a, sessionId: 'same' }, { serverId: b, sessionId: 'same' }];
        const result = await setTrackedSessionIds({ sessionAddresses: addresses, corpus: corpus(addresses, [a, b]) });
        expect(result).toMatchObject({ ok: true, sessionAddresses: addresses });
        expect(replacementRequests()).toEqual([{ serverId: a, sessionIds: ['same'] }, { serverId: b, sessionIds: ['same'] }]);
    });
    it('fails released bare ids closed when the id exists on multiple Homes', async () => {
        storage.setState({ ordinarySessionListMembershipByServerId: { [a]: ['same'], [b]: ['same'] } });
        await expect(setTrackedSessionIds({ sessionIds: ['same'] }))
            .resolves.toMatchObject({ ok: false, status: 'ambiguous', error: { code: 'session_ambiguous', sessionId: 'same' } });
        expect(replacementRequests()).toEqual([]);
    });
    it('does not publish a transient target projection when the durable Follow mutation fails', async () => {
        home.answer(a, `PUT ${SESSION_FOLLOW_HTTP_PATHS_V1.voiceInclusions}`, { status: 503, body: {} });
        const result = await setTrackedSessionIds({ sessionIds: ['s2'], serverId: a,
            corpus: corpus([{ serverId: a, sessionId: 's2' }]),
        });
        expect(result).toMatchObject({ ok: false, status: 'unavailable', error: { code: 'session_follow_unavailable' } });
        expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual([]);
        expect(persistedInclusions.get(a)).toBeUndefined();
    });
    it('resolves the primary action session by human title without storing sentence punctuation', async () => {
        const result = await setPrimaryActionSessionId({ sessionId: null, sessionTitle: 'Session Setup.',
            corpus: { activeServerId: a, knownServerIds: [a], coverage: 'complete' },
        });
        expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: a, sessionId: 's3' });
        expect(result).toMatchObject({ ok: true, sessionId: 's3', session: { id: 's3', title: 'Session Setup' } });
    });
    it('prefers the visible session title over a stale raw session title for the same session id', async () => {
        const result = await setPrimaryActionSessionId({ sessionId: null, sessionTitle: 'Session QA Voice Matrix',
            corpus: { activeServerId: a, knownServerIds: [a], coverage: 'complete' },
        });
        expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: a, sessionId: 's4' });
        expect(result).toMatchObject({ ok: true, sessionId: 's4', session: { id: 's4', title: 'Session QA Voice Matrix' } });
    });
    it('returns the visible lookup title when a stale raw title normalizes to the same lookup text', async () => {
        storage.setState(current => ({ sessions: { ...current.sessions, s4: createSessionFixture({ id: 's4', serverId: a,
            metadata: { ...fixtureMetadata, summaryText: 'Session QA Voice Matrix!' }, updatedAt: 10,
        }) } }));
        const result = await setPrimaryActionSessionId({ sessionId: null, sessionTitle: 'Session QA Voice Matrix',
            corpus: { activeServerId: a, knownServerIds: [a], coverage: 'complete' },
        });
        expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual({ serverId: a, sessionId: 's4' });
        expect(result).toMatchObject({ ok: true, sessionId: 's4', session: { id: 's4', title: 'Session QA Voice Matrix' } });
    });
});
