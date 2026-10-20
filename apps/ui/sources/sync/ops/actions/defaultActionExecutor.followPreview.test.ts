import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture, createPlainSessionByIdResponseFixture, createSessionOwnerViewerFixture, createSessionAccessFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { SessionListQueryResponseV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { encodeV2SessionListCursorV1 } from '@happier-dev/protocol';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createWorkflowDefinitionFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { sealWorkflowAcceptedSnapshotStoredEnvelopeV1, serializeWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { WorkflowRunRecipientCensusResponseV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
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
function queryRow(session: ReturnType<typeof createSessionFixture>) {
    return { ...createPlainSessionByIdResponseFixture(session).session, viewer: createSessionOwnerViewerFixture(session) };
}
async function addAppliedHome(name: string, serverUrl: string) {
    const serverId = await homes.addHome({ name, serverUrl, accountId: 'alice', currentAccount: true });
    restoredAccount = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: homes.request });
    expect(restoredAccount.serverId).toBe(serverId);
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    return serverId;
}
beforeEach(async () => { await homes.reset(); });
afterEach(async () => { await restoredAccount?.dispose(); restoredAccount = undefined;
    getStorage().setState(initial, true); standardCleanup(); });

it('resolves matching through every ordinary and attention page without changing mounted membership', async () => {
    const serverId = await addAppliedHome('Complete', 'https://complete-preview.test');
    const before = getStorage().getState().ordinarySessionListMembershipByServerId;
    const pages: unknown[] = [];
    const ordinaryCursor = encodeV2SessionListCursorV1('ordinary-next');
    const attentionCursor = encodeV2SessionListCursorV1('attention-next');
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/sessions/query', { select: body => {
        const query = SessionListQueryV1Schema.parse(body);
        pages.push(query);
        const id = query.attentionCursor ? 'attention-match' : query.cursor ? 'older-match' : 'first-match';
        return { body: SessionListQueryResponseV1Schema.parse({ sessions: [queryRow(createSessionFixture({ id,
            metadata: { path: '/repo', host: 'test', projectId: 'payments' } }))],
            nextCursor: query.cursor || query.attentionCursor ? null : ordinaryCursor, hasNext: !query.cursor && !query.attentionCursor,
            attentionNextCursor: query.attentionCursor ? null : attentionCursor, attentionHasNext: !query.attentionCursor }) };
    } });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], scope: 'all_accessible',
        startedBy: ['you', 'agents', 'triggers'], projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const executor = createDefaultActionExecutor();
    const preview = await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter: { ...filter, show: 'sessions' } },
        { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 3 } });
    expect(await executor.previewSessionTargets({ selector: 'matching', filter },
        { surface: 'ui', serverId, expectedAccountId: 'alice' })).toMatchObject({ coverage: 'complete', addresses: [
        { serverId, sessionId: 'first-match' }, { serverId, sessionId: 'older-match' }, { serverId, sessionId: 'attention-match' },
    ] });
    pages.length = 0;
    const result = await executor.execute('session.status.get', { sessionId: { selector: 'matching', filter } },
        { surface: 'ui', serverId, expectedAccountId: 'alice' });
    // Status effects may fail without a Machine; resolution must nevertheless retain the complete concrete list.
    expect(result, JSON.stringify({ result, pages })).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
        { target: { serverId, sessionId: 'first-match' } }, { target: { serverId, sessionId: 'older-match' } },
        { target: { serverId, sessionId: 'attention-match' } },
    ] } });
    expect(pages).toHaveLength(3);
    expect(getStorage().getState().ordinarySessionListMembershipByServerId).toEqual(before);
});

it('previews portable-Home rules and Matching against the same captured local Home', async () => {
    const portable = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const serverUrl = 'https://portable-preview.test';
    const serverId = await homes.addHome({ name: 'Portable', serverUrl, serverIdentityId: portable, accountId: 'alice', currentAccount: true });
    restoredAccount = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: homes.request });
    const { sync } = await import('@/sync/sync');
    await sync.awaitBootstrapForegroundAcquisition();
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const candidate = createSessionFixture({ id: 'portable-project-member', serverId,
        metadata: { path: '/payments', host: 'test', projectId: 'payments' } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/sessions/query', { body: SessionListQueryResponseV1Schema.parse({ sessions: [queryRow(candidate)],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null }) });
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [portable], scope: 'all_accessible',
        startedBy: ['you', 'agents', 'triggers'], projects: { include: [{ serverId: portable, projectKey: 'payments' }], exclude: [] } });
    const executor = createDefaultActionExecutor();
    const context = { surface: 'ui' as const, serverId, expectedAccountId: 'alice' };
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter }, context))
        .toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 1,
            matches: [{ source: { kind: 'session', sessionId: candidate.id } }] } });
    expect(await executor.previewSessionTargets({ selector: 'matching', filter }, context))
        .toMatchObject({ coverage: 'complete', addresses: [{ sessionId: candidate.id }] });
});

it.each(['network', 'repeated_cursor', 'metadata_unavailable'] as const)('refuses matching for %s incompleteness', async reason => {
    const serverId = await addAppliedHome('Incomplete', 'https://incomplete-preview.test');
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId], scope: 'all_accessible',
        startedBy: ['you', 'agents', 'triggers'] });
    const executor = createDefaultActionExecutor();
    const cursor = encodeV2SessionListCursorV1('next');
    const requestedCursors: (string | undefined)[] = [];
    homes.answer(serverId, '/v2/sessions/query', { select: body => {
        const query = SessionListQueryV1Schema.parse(body);
        requestedCursors.push(query.cursor);
        if (reason === 'network' && query.cursor) return { status: 503, body: { error: 'unavailable' } };
        return { body: SessionListQueryResponseV1Schema.parse({
            sessions: [queryRow(createSessionFixture({ id: 'known-candidate' }))],
            hasNext: reason !== 'metadata_unavailable', nextCursor: reason === 'metadata_unavailable' ? null : cursor,
            attentionHasNext: false, attentionNextCursor: null,
            ...(reason === 'metadata_unavailable' ? { metadataUpgradeRequiredCount: 1 } : {}),
        }) };
    } });
    expect(await executor.execute('session.status.get', { sessionId: { selector: 'matching', filter } },
        { surface: 'ui', serverId, expectedAccountId: 'alice' }), reason)
        .toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
    if (reason !== 'metadata_unavailable') expect(requestedCursors, reason).toContain(cursor);
});

it('previews rules from current authorized query rows without admitting unrelated retained rows', async () => {
    const serverId = await addAppliedHome('Rules', 'https://rules.test');
    const session = createSessionFixture({ id: 'payments', serverId,
        metadata: { path: '/repo', host: 'test', projectId: 'payments' } });
    const retained = createSessionFixture({ ...session, id: 'retained-only' });
    getStorage().setState({ isDataReady: true, sessions: { [session.id]: session, [retained.id]: retained },
        sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session),
            [retained.id]: buildSessionListRenderableFromSession(retained) } },
        ordinarySessionListMembershipByServerId: { [serverId]: [session.id, retained.id] },
    });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/sessions/query', { body: SessionListQueryResponseV1Schema.parse({
        sessions: [queryRow(session)], hasNext: false, nextCursor: null,
        attentionHasNext: false, attentionNextCursor: null,
    }) });
    const filter = normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'],
        projects: { include: [{ serverId, projectKey: 'payments' }], exclude: [] } });
    const result = await createDefaultActionExecutor().execute('follow.preview', { receiver: { kind: 'account' }, filter },
        { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 1,
        matches: [{ serverId, source: { kind: 'session', sessionId: session.id } }] } });
    expect(homes.requests.filter(request => /^\/v[12]\/sessions(?:\?|$)/.test(request.path))).toEqual([]);
});

it('reports unreadable Project candidates as unavailable and withholds stale Account rows', async () => {
    const serverId = await addAppliedHome('Locked', 'https://locked-preview.test');
    const session = createSessionFixture({ id: 'locked', serverId, encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending',
        metadata: { path: '/repo', host: 'test', projectId: 'payments' } });
    getStorage().setState({ isDataReady: true, sessions: { [session.id]: session },
        sessionListRowsByServerId: { [serverId]: { [session.id]: buildSessionListRenderableFromSession(session) } },
        ordinarySessionListMembershipByServerId: { [serverId]: [session.id] } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    const shared = queryRow(createSessionFixture({ id: session.id, access: createSessionAccessFixture('edit'),
        viewer: createSessionViewerFixture(), metadata: { path: '/repo', host: 'test', projectId: 'payments' } }));
    homes.answer(serverId, '/v2/sessions/query', { body: SessionListQueryResponseV1Schema.parse({
        sessions: [{ ...shared, encryptionMode: 'e2ee', metadata: 'unavailable-encrypted-content' }],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
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
    homes.answer(serverId, '/v2/sessions/query', { body: SessionListQueryResponseV1Schema.parse({
        sessions: [queryRow(session)], hasNext: false, nextCursor: null,
        attentionHasNext: false, attentionNextCursor: null,
    }) });
    expect(await createDefaultActionExecutor().execute('follow.preview', { receiver, filter }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 1,
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
    homes.answer(serverId, '/v3/automations/runs/workflow-storage', { body: {
        runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {},
    } });
    homes.answer(serverId, '/v2/sessions/query', { body: SessionListQueryResponseV1Schema.parse({
        sessions: [], hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
    expect(await executor.execute('follow.preview', { receiver: { kind: 'account' }, filter: { ...filter, underSessionId: 'manager' } }, { surface: 'ui', serverId }))
        .toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 0, unavailable: [] } });
    expect(homes.requestsFor('/v3/automations/runs/workflow-storage').at(-1)?.input)
        .toMatchObject({ request: { underSessionId: 'manager' } });
});

it('previews an Under Run only from server-proved descendant membership', async () => {
    const serverId = await addAppliedHome('Under Runs', 'https://under-runs-preview.test');
    getStorage().setState({ isDataReady: true });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/sessions/query', { select: body => {
        const query = SessionListQueryV1Schema.parse(body);
        expect(query.underSessionId).toBe('manager');
        const id = query.cursor ? 'leaf' : 'manager';
        return { body: SessionListQueryResponseV1Schema.parse({ sessions: [queryRow(createSessionFixture({ id, serverId }))],
            nextCursor: query.cursor ? null : encodeV2SessionListCursorV1('next-subtree-page'), hasNext: !query.cursor,
            attentionNextCursor: null, attentionHasNext: false }) };
    } });
    const run = createWorkflowRunSummaryFixture({ id: 'descendant-run', ownerAccountId: 'alice', startedBy: 'user',
        origin: { kind: 'direct', originSessionId: 'leaf' } });
    const materialized = await materializeWorkflowAcceptedSnapshotV1({ definition: createWorkflowDefinitionFixture({
        blocks: [{ kind: 'wait', id: 'wait', document: { text: 'Continue', references: [], attachments: [] } }],
    }),
        admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true },
        context: { source: { kind: 'inline' }, inputs: {}, machineId: run.machineId, executionTarget: { kind: 'session' },
            origin: { kind: 'direct', originSessionId: 'leaf' }, authorization: { principal: { kind: 'host' } },
            workspaceTarget: { project: { machineId: run.machineId, directory: '/repo', checkoutRootPath: '/repo' } } } });
    if (!materialized.ok) throw new Error(`Invalid accepted fixture: ${materialized.error.code}`);
    const envelope = serializeWorkflowStoredContentEnvelopeV1(sealWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'alice', runId: run.id }, acceptedSnapshot: materialized.snapshot }));
    const census = WorkflowRunRecipientCensusResponseV1Schema.parse({ runId: run.id, ownerAccountId: 'alice',
        access: 'owner', encryptionMode: 'plain', visibleTeamId: null, dataEncryptionKey: null,
        callerDataEncryptionKey: null, recipients: [], ownerAccountCurrentness: { mode: 'plain', version: 1, contentKeyFingerprint: null } });
    homes.answer(serverId, '/v3/automations/runs/workflow-storage', { select: body => {
        const operation = body as { request: { underSessionId?: string; cursor?: string } };
        expect(operation.request.underSessionId).toBe('manager');
        return { body: operation.request.cursor ? { runs: [run], acceptedEnvelopesByRunId: { [run.id]: envelope },
            keyCensusByRunId: { [run.id]: census } } : { runs: [], acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, nextCursor: 'next-run-page' } };
    } });
    const filter = normalizeSessionListFilterV1({ homeServerIds: [serverId], show: 'runs', underSessionId: 'manager',
        scope: 'all_accessible', startedBy: ['you'] });
    expect(await createDefaultActionExecutor().execute('follow.preview', { receiver: { kind: 'account' }, filter },
        { surface: 'ui', serverId, expectedAccountId: 'alice' }))
        .toMatchObject({ ok: true, result: { coverage: 'complete', matchCount: 1,
            matches: [{ serverId, source: { kind: 'workflow_run', runId: run.id } }] } });
});
