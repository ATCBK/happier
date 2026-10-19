import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createPlainSessionCurrentProjectionRecordFixture, createSessionAccessFixture, createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const initial = getStorage().getState();
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { await homes.reset(); });
afterEach(async () => {
    await restored?.dispose(); restored = undefined;
    getStorage().setState(initial, true); standardCleanup();
});

it('resolves rule Session followers through the captured own-Account census and excludes private people', async () => {
    const serverUrl = 'https://follow-targets.test';
    const serverId = await homes.addHome({ name: 'Followers', serverUrl, accountId: 'alice', currentAccount: true });
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: homes.request });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const sessions = ['source', 'rule-receiver', 'direct-receiver'].map(id => createSessionFixture({ id, serverId,
        encryptionMode: 'plain', access: createSessionAccessFixture('view') }));
    getStorage().setState({ isDataReady: true,
        sessions: Object.fromEntries(sessions.map(session => [session.id, session])),
        sessionListRowsByServerId: { [serverId]: Object.fromEntries(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)])) },
        ordinarySessionListMembershipByServerId: { [serverId]: sessions.map(session => session.id) },
    });
    for (const session of sessions) homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
    homes.answer(serverId, '/v2/sessions/source/follows/followers', { body: {
        follows: [], sources: [{ sourceSessionId: 'source', destinationSessionId: 'direct-receiver', relation: 'follower',
            policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false }], rules: [], coverage: 'complete', peopleCount: 3,
    } });
    homes.answer(serverId, '/v2/sessions/query', { body: SessionListQueryResponseV1Schema.parse({
        sessions: [createPlainSessionCurrentProjectionRecordFixture({ id: 'source', viewer: createSessionViewerFixture() })],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
    const definition = { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId],
        scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'] }), policy: { preset: 'quiet' } };
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [
        { ruleId: 'personal', receiver: { kind: 'account' }, version: 0, content: { t: 'plain', v: definition } },
        { ruleId: 'coordinator', receiver: { kind: 'session', sessionId: 'rule-receiver' }, version: 0, content: { t: 'plain', v: definition } },
    ] } });
    const executor = createDefaultActionExecutor();
    const result = await executor.execute('session.status.get', {
        sessionId: { selector: 'followers', of: 'source' },
    }, { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
        { target: { serverId, sessionId: 'direct-receiver' }, result: { ok: true } },
        { target: { serverId, sessionId: 'rule-receiver' }, result: { ok: true } },
    ] } });
    homes.answer(serverId, '/v2/sessions/rule-receiver', { status: 404, body: { error: 'session_not_found' } });
    const receiverReadsBeforeDenial = homes.requests.filter(request => request.path.split('?')[0] === '/v2/sessions/rule-receiver').length;
    const directEffectsBeforeDenial = homes.requests.filter(request => request.path.split('?')[0] === '/v2/sessions/direct-receiver').length;
    expect(await executor.execute('session.status.get', { sessionId: { selector: 'followers', of: 'source' } },
        { surface: 'ui', serverId, expectedAccountId: 'alice' })).toMatchObject({ ok: false,
        errorCode: 'session_target_unavailable', details: { cause: 'follow_receiver_unavailable' } });
    // Only the preparation access read runs; the status effect never starts.
    expect(homes.requests.filter(request => request.path.split('?')[0] === '/v2/sessions/rule-receiver'))
        .toHaveLength(receiverReadsBeforeDenial + 1);
    expect(homes.requests.filter(request => request.path.split('?')[0] === '/v2/sessions/direct-receiver'))
        .toHaveLength(directEffectsBeforeDenial);
    homes.answer(serverId, '/v2/sessions/rule-receiver', { body: createPlainSessionByIdResponseFixture(sessions[1]!) });
    homes.answer(serverId, '/v2/account/session-follow-rules', { status: 403, body: { error: 'credential_scope_denied' } });
    expect(await executor.execute('session.status.get', { sessionId: { selector: 'followers', of: 'source' } },
        { surface: 'ui', serverId, expectedAccountId: 'alice' })).toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
});
