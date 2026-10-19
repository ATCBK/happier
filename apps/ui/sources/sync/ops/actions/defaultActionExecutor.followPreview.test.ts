import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture, createSessionViewerFixture, createSessionAccessFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import type { FollowReceiverRefV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { getStorage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
const initial = getStorage().getState();
let restoredAccount: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
async function addAppliedHome(name: string, serverUrl: string) {
    const serverId = await homes.addHome({ name, serverUrl, accountId: 'alice', currentAccount: true });
    restoredAccount = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: homes.request });
    expect(restoredAccount.serverId).toBe(serverId);
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    return serverId;
}
beforeEach(async () => { await homes.reset(); });
afterEach(async () => { await restoredAccount?.dispose(); restoredAccount = undefined;
    getStorage().setState(initial, true); standardCleanup(); });

it('previews rules over loaded authorized rows through the real Action without fetching another Session list', async () => {
    const serverId = await addAppliedHome('Rules', 'https://rules.test');
    const session = createSessionFixture({ id: 'payments', serverId, access: createSessionAccessFixture('edit'),
        viewer: createSessionViewerFixture(), metadata: { path: '/repo', host: 'test', projectId: 'payments' } });
    getStorage().setState({ isDataReady: true, sessions: { [session.id]: session },
        sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
        ordinarySessionListMembershipByServerId: { [serverId]: [session.id] },
    });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'],
        projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const result = await createDefaultActionExecutor().execute('follow.preview', { receiver: { kind: 'account' }, filter },
        { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { coverage: 'partial', matchCount: 1,
        matches: [{ serverId, source: { kind: 'session', sessionId: session.id } }] } });
    expect(homes.requests.filter(request => /^\/v[12]\/sessions(?:\?|$)/.test(request.path))).toEqual([]);
});

it('reports locked Project candidates as unavailable and withholds stale Account rows', async () => {
    const serverId = await addAppliedHome('Locked', 'https://locked-preview.test');
    const session = createSessionFixture({ id: 'locked', serverId, encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending',
        metadata: { path: '/repo', host: 'test', projectId: 'payments' } });
    getStorage().setState({ isDataReady: true, sessions: { [session.id]: session },
        sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
        ordinarySessionListMembershipByServerId: { [serverId]: [session.id] } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'],
        projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const executor = createDefaultActionExecutor();
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, { surface: 'ui', serverId, expectedAccountId: 'alice' }))
        .toMatchObject({ ok: true, result: { coverage: 'partial', matchCount: 0,
            unavailable: [{ serverId, source: { kind: 'session', sessionId: session.id } }] } });
    getStorage().setState({ profileScope: { serverId, accountId: 'old-account' } });
    const stale = await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(stale).toMatchObject({ ok: false });
    expect(stale).not.toHaveProperty('result');
});

it('offers overlaps only with other Session receivers, not personal rules or the current receiver', async () => {
    const serverId = await addAppliedHome('Overlaps', 'https://overlaps-preview.test');
    const session = createSessionFixture({ id: 'payments', serverId, metadata: { path: '/repo', host: 'test', projectId: 'payments' } });
    getStorage().setState({ isDataReady: true, sessions: { [session.id]: session },
        sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
        ordinarySessionListMembershipByServerId: { [serverId]: [session.id] } });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'],
        projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const receiver = { kind: 'session' as const, sessionId: 'current' };
    const rule = (ruleId: string, target: FollowReceiverRefV1) => ({ ruleId, receiver: target, version: 0,
        content: { t: 'plain', v: { v: 1, enabled: true, filter, policy: { preset: 'important' } } } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [
        rule('personal', { kind: 'account' }), rule('current', receiver),
        rule('other', { kind: 'session', sessionId: 'other-coordinator' }),
    ] } });
    expect(await createDefaultActionExecutor().execute('follow.preview', { receiver, filter }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'partial', matchCount: 1,
            overlaps: [{ ruleId: 'other', matches: [{ serverId, source: { kind: 'session', sessionId: session.id } }] }] } });
});

it('keeps unavailable reads distinct from an empty loaded preview', async () => {
    const serverId = await addAppliedHome('Pending', 'https://pending-preview.test');
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible' });
    const executor = createDefaultActionExecutor();
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    getStorage().setState({ isDataReady: false });
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'unavailable', matchCount: 0 } });
    getStorage().setState({ isDataReady: true });
    homes.answer(serverId, '/v2/account/session-follow-rules', { status: 503, body: { error: 'unavailable' } });
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'unavailable', matchCount: 0 } });
});

it('previews native loaded Runs only in their captured Home and Account', async () => {
    const serverId = await addAppliedHome('Runs', 'https://runs-preview.test');
    getStorage().setState({ isDataReady: true });
    const run = createWorkflowRunSummaryFixture({ id: 'run', ownerAccountId: 'alice', startedBy: 'user' });
    getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(run)], { serverId, accountId: 'alice' });
    getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({
        id: 'readable-team-run', ownerAccountId: 'bob', visibleTeamId: 'team', startedBy: 'user',
    }))], { serverId, accountId: 'alice' });
    getStorage().getState().upsertWorkflowRuns([workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'foreign', ownerAccountId: 'bob' }))], { serverId, accountId: 'bob' });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], show: 'runs', scope: 'all_accessible', startedBy: ['you'] });
    const executor = createDefaultActionExecutor();
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'partial', matchCount: 1,
            matches: [{ serverId, source: { kind: 'workflow_run', runId: run.id } }] } });
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter: { ...filter, underSessionId: 'manager' } }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'partial', matchCount: 0,
            unavailable: [{ serverId, source: { kind: 'workflow_run', runId: run.id } }] } });
});
