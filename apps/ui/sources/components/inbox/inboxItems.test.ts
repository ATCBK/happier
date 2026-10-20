import { describe, expect, it } from 'vitest';
import { createAccountNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { AccountNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { SessionQuestionContextV1Schema } from '@happier-dev/protocol/sessions/permissions/v1';
import type { Session } from '@/sync/domains/state/storageTypes';
import { buildInboxItems, type InboxItem, type InboxItemsInput } from './inboxItems';
import { DiscussionOpenedSummaryV1Schema, DiscussionOpenedMessageV1Schema } from '@happier-dev/protocol/discussions/actions';
import { createDiscussionMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { DiscussionMessageV1Schema } from '@happier-dev/protocol/discussions/models';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1, buildTargetActionApprovalArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { resolveAccountActorPresentation } from '@/sync/domains/account/accountActorPresentation';
import { readInboxSessionTitle } from './sessionAttention/inboxSessionPrivacy';
import { countInbox, countInboxNeedsYou } from './inboxCounts';

const emptyInput: InboxItemsInput = { sessionPresentation: { sessionsNeedingAttention: [], readySessions: [],
    markAllReadTargets: [], pendingRequestHydrationTargets: [] }, workGroups: [], workflowServerId: 'home-a',
    accountServerId: 'home-a', notices: [] };

async function input(overrides: Partial<Session> = {}): Promise<InboxItemsInput> {
    const { buildActivityOverviewSnapshot } = await import('@/activity/attention/buildActivityOverviewSnapshot');
    const { buildInboxSessionPresentation } = await import('@/activity/presentation/buildInboxSessionPresentation');
    const { buildInboxWorkGroups } = await import('@/activity/presentation/buildInboxWorkGroups');
    const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
    const session = createSessionFixture({ id: 'ask', serverId: 'home-a', active: true,
        pendingPermissionRequestCount: 1, pendingRequestObservedAt: 1_000, ...overrides });
    const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewSnapshot({ sessions: [session], nowMs: 1_000 }) });
    return { sessionPresentation, workGroups: buildInboxWorkGroups({
        sessionEntries: sessionPresentation.sessionsNeedingAttention, workflowRuns: [], automationRuns: [],
        automationServerId: null, openApprovals: [], stalledSessions: [], landings: [], snoozed: [],
        resolveSession: () => session, resolveOriginRunId: () => null,
    }), workflowServerId: 'home-a', accountServerId: 'home-a', notices: [] };
}

describe('one Inbox row projection', () => {
    it('keeps cached Session names unavailable when only status is readable', async () => {
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const session = createSessionFixture({ id: 'locked-source', serverId: 'home-a', encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_content_unavailable', metadata: { name: 'Private cached project', path: '/private/path', host: 'private-host' } });
        const [row] = buildInboxItems({ ...emptyInput, workGroups: [{ key: 'other', root: { kind: 'other' },
            items: [{ kind: 'stalled', key: 'stalled:locked-source', session }] }] });
        expect(row).toMatchObject({ title: readInboxSessionTitle(session, 'home-a'),
            source: { displayName: readInboxSessionTitle(session, 'home-a') } });
        expect(JSON.stringify(row)).not.toContain('Private cached project');
    });
    it('offers simple approval decisions only for the exact open, readable request', () => {
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli' }, actionId: 'account.name.set', actionArgs: { name: 'Captain' }, summary: 'Change name',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                serverId: 'request-home', actionId: 'account.name.set', requestId: 'request-a' } });
        const artifact = { id: 'approval-a', isDecrypted: true, title: request.summary,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } satisfies DecryptedArtifact;
        const rowsFor = (value: DecryptedArtifact, previous: readonly InboxItem[] = []) => buildInboxItems({ ...emptyInput,
            workGroups: [{ key: 'other', root: { kind: 'other' },
                items: [{ kind: 'approval', key: 'approval:approval-a', artifact: value }] }] }, previous);
        const rows = rowsFor(artifact);
        expect(rows[0]).toHaveProperty('approvalQuickActions', { artifactId: artifact.id, serverId: 'request-home',
            actionId: 'approval.request.decide', decisions: ['reject', 'approve'] });
        expect(rowsFor(artifact, rows)).toBe(rows);
        expect(rowsFor({ ...artifact, body: null }, rows)[0]).not.toHaveProperty('approvalQuickActions');
        for (const unavailable of [
            { ...artifact, body: null },
            { ...artifact, body: '{broken' },
            { ...artifact, header: { ...artifact.header, actionId: 'session.stop' } },
            { ...artifact, body: JSON.stringify({ ...request, actionArgs: { name: 'Captain', unreviewed: true } }) },
            { ...artifact, body: JSON.stringify({ ...request, unknownAuthority: true }) },
            { ...artifact, header: { ...artifact.header, actionId: 'unknown.action' }, body: JSON.stringify({ ...request,
                actionId: 'unknown.action', executionOriginV1: { ...request.executionOriginV1, actionId: 'unknown.action' } }) },
            { ...artifact, body: JSON.stringify({ ...request, actionArgs: {} }) },
            { ...artifact, header: buildApprovalRequestArtifactHeaderV1({ ...request, status: 'rejected' }),
                body: JSON.stringify({ ...request, status: 'rejected' }) },
        ]) expect(rowsFor(unavailable)[0]).not.toHaveProperty('approvalQuickActions');
        const plugin = TargetActionApprovalRequestV1Schema.parse({ v: 1, kind: 'plugin_target_action', status: 'open',
            createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'agent' }, requestedSurface: 'agent',
            qualifiedActionId: 'acme.publisher/actions/publish', sourceCustody: { kind: 'development', registeredRootId: 'root-a' },
            policyFingerprint: 'a'.repeat(64), subjectFingerprint: 'b'.repeat(64), summary: 'Publish',
            input: { destination: 'releases' }, secretInputPaths: [] });
        expect(rowsFor({ ...artifact, header: buildTargetActionApprovalArtifactHeaderV1(plugin), body: JSON.stringify(plugin) })[0])
            .not.toHaveProperty('approvalQuickActions');
        expect(buildInboxItems({ ...emptyInput, workGroups: [] }, rows)).toEqual([]);
    });
    it('projects exact qualified live Discussion mentions and Doc anchors, then drops them on owner read', () => {
        const scope = { serverId: 'home-b', accountId: 'me' };
        const summary = DiscussionOpenedSummaryV1Schema.parse({ id: 'thread', ownerAccountId: 'me', encryptionMode: 'plain',
            anchor: { kind: 'doc', doc: { ref: { kind: 'doc', artifactId: 'plan-doc', serverId: 'home-b' },
                revision: { headerVersion: 1, bodyVersion: 2 } } }, access: 'owner', keyReadiness: true, dataEncryptionKey: null,
            creationLocalId: null, title: 'Doc review', latestMessage: { id: 'newer-chatter', localId: null, seq: 3,
                authorAccountId: null, accountActor: null, producerV1: null, createdAt: 3 },
            messageSeq: 3, lastReadSeq: 1, unreadCount: 2, unreadMentionCount: 1, recentAuthorAccountIds: [], archivedAt: null,
            capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } });
        const committed = DiscussionMessageV1Schema.parse({ id: 'actual-mention', discussionId: 'thread', localId: null,
            seq: 2, authorAccountId: 'alice', accountActor: { v: 1, accountId: 'alice',
                profile: { name: 'Alice Chen', firstName: 'Alice', lastName: 'Chen', username: 'alice', avatarUrl: null } }, producerV1: null,
            content: { t: 'plain', v: { v: 1, parts: [{ t: 'text', text: 'Please\n review' }] } },
            mentionedAccountIds: ['me'], createdAt: 2 });
        const message = DiscussionOpenedMessageV1Schema.parse({ ...committed,
            content: committed.content.t === 'plain' ? committed.content.v : null,
            messageRef: createDiscussionMessageRefV1({ serverId: 'home-b', discussionId: 'thread' }, committed) });
        const source = (opened = message, discussion = summary, type: 'mention' | 'decision' = 'mention') => ({ scope,
            entries: [{ discussion, occurrences: [{ message: opened, type }] }] });
        const before = buildInboxItems({ ...emptyInput, discussions: source() });
        const mention = before.find(item => item.view === 'mentions');
        expect(mention).toMatchObject({ focus: { kind: 'discussion', serverId: 'home-b', id: 'thread', messageId: 'actual-mention' },
            source: { displayName: 'Doc review' }, excerpt: 'Please review',
            author: resolveAccountActorPresentation({ ...committed.accountActor!, serverId: scope.serverId }, scope),
            discussion: { messageRef: message.messageRef, anchor: summary.anchor } });
        expect(mention?.pageRoute).toBe('/discussions/thread?serverId=home-b&messageId=actual-mention');
        expect(buildInboxItems({ ...emptyInput, discussions: source() }, before)).toBe(before);
        const editedMessage = { ...message, content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'Changed excerpt' }] } };
        const edited = buildInboxItems({ ...emptyInput, discussions: source(editedMessage) }, before);
        expect(edited[0]).not.toBe(before[0]);
        expect(edited[0]?.excerpt).toBe('Changed excerpt');
        const renamedAuthor = { ...message, accountActor: { ...message.accountActor!, profile: { ...message.accountActor!.profile!, name: 'Alice renamed' } } };
        const renamed = buildInboxItems({ ...emptyInput, discussions: source(renamedAuthor) }, before);
        expect(renamed[0]).not.toBe(before[0]);
        expect(renamed[0]?.author?.name).toBe('Alice renamed');
        const producedMessage = DiscussionOpenedMessageV1Schema.parse({ ...message, authorAccountId: null, accountActor: null,
            producerV1: { v: 1, kind: 'agent', sessionId: 'payments-bot' } });
        const produced = { ...emptyInput, discussions: { ...source(producedMessage),
            sessionDisplayNames: new Map([['payments-bot', 'Payments coordinator']]) } };
        const botRows = buildInboxItems(produced, before);
        expect(botRows[0]?.author).toEqual({ name: 'Payments coordinator' });
        expect(botRows[0]).not.toBe(before[0]);
        expect(buildInboxItems({ ...produced, discussions: { ...produced.discussions, sessionDisplayNames: new Map() } }, botRows)[0]?.author).toBeNull();
        expect(buildInboxItems({ ...emptyInput, discussions: source({ ...message, content: null }) }, before)).toEqual([]);
        const read = { ...summary, lastReadSeq: 3, unreadCount: 0, unreadMentionCount: 0 };
        expect(buildInboxItems({ ...emptyInput, discussions: source(message, read, 'decision') }, before)[0])
            .toMatchObject({ type: 'decision', view: 'needs_you', read: true });
        const countsFor = (items: readonly InboxItem[]) => ({ items, openApprovals: [], openUsageNotices: [],
            actionOperationEntries: [], friendRequests: [], sessionPresentation: emptyInput.sessionPresentation,
            workflowAttention: { runIds: [] }, automationAttention: { runIds: [] } });
        for (const discussion of [summary, read]) {
            const model = countsFor(buildInboxItems({ ...emptyInput, discussions: source(message, discussion, 'decision') }));
            expect(countInboxNeedsYou(model)).toBe(1);
            expect(countInbox(model)).toBe(1);
        }
        expect(countInbox(countsFor(buildInboxItems({ ...emptyInput, discussions: { scope, entries: [] } })))).toBe(0);
        expect(buildInboxItems({ ...emptyInput, discussions: { scope, entries: [] } }, before)).toEqual([]);
    });
    it.each(['blocked', 'decision', undefined] as const)('projects the canonical pending question subtype %s', async type => {
        const current = await input({ pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1,
            agentState: { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action',
                arguments: { questions: [{ question: 'What next?' }] }, createdAt: 100,
                questionV1: SessionQuestionContextV1Schema.parse({ mode: 'continue', assumption: 'Keep working',
                    lasting: false, ...(type ? { type } : {}) }),
            } } },
        });
        expect(current.sessionPresentation.sessionsNeedingAttention[0]?.pendingUserActions[0]?.questionV1?.type).toBe(type);
        expect(buildInboxItems(current)).toEqual([expect.objectContaining({ type: type ?? 'decision', view: 'needs_you' })]);
    });

    it('keeps oldest-question selection, approval precedence, and unavailable-request fallback', async () => {
        const request = { tool: 'AskUserQuestion', kind: 'user_action', arguments: {}, createdAt: 100 };
        const agentState = { requests: {
            newer: { ...request, createdAt: 200, questionV1: SessionQuestionContextV1Schema.parse({
                mode: 'wait', type: 'blocked', lasting: false }) },
            older: { ...request, questionV1: SessionQuestionContextV1Schema.parse({
                mode: 'wait', type: 'decision', lasting: false }) },
        } };
        const current = await input({ pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 2, agentState });
        expect(current.sessionPresentation.sessionsNeedingAttention[0]?.pendingUserActions.map(value => value.id))
            .toEqual(['older', 'newer']);
        expect(buildInboxItems(current)[0]).toMatchObject({ type: 'decision' });
        const approval = await input({ pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 2, agentState });
        expect(buildInboxItems(approval)[0]).toMatchObject({ type: 'approval' });
        const unavailable = await input({ pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 1 });
        expect(unavailable.sessionPresentation.sessionsNeedingAttention[0]?.pendingUserActions).toEqual([]);
        expect(buildInboxItems(unavailable)[0]).toMatchObject({ type: 'decision' });
    });

    it('joins a live owner and a private plugin notice without retaining settled live work', async () => {
        const current = await input();
        const artifact = createAccountNoticeArtifactFixture({ header: { body: 'Review the change', excerpt: 'Opened preview' } });
        const notice = { artifact, header: AccountNoticeArtifactHeaderV1Schema.parse(artifact.rawHeader) };
        const named = { ...current, notices: [notice], pluginDisplayNames: new Map([['acme.review', 'Acme Review']]) };
        const rows = buildInboxItems(named);
        expect(rows.map(row => [row.producer, row.view])).toEqual([['live', 'needs_you'], ['notice', 'updates']]);
        expect(rows[0]?.source).toMatchObject({ displayName: current.sessionPresentation.sessionsNeedingAttention[0]?.candidate.title });
        expect(rows[1]).toMatchObject({ source: { displayName: 'Acme Review' }, author: null, excerpt: 'Review the change' });
        expect(buildInboxItems(named, rows)).toBe(rows);
        const renamed = buildInboxItems({ ...named, pluginDisplayNames: new Map([['acme.review', 'Review renamed']]) }, rows);
        expect(renamed[0]).toBe(rows[0]);
        expect(renamed[1]).not.toBe(rows[1]);
        expect(renamed[1]?.source.displayName).toBe('Review renamed');
        expect(buildInboxItems({ ...current, notices: [notice] })[1]).toMatchObject({ source: { displayName: null }, author: null });
        expect(rows[1]?.pageRoute).toBe('/plugins/acme.review/reviews/42');
        const settled = buildInboxItems({ ...named, workGroups: [] }, rows);
        expect(settled).toHaveLength(1);
        expect(settled[0]).toBe(rows[1]);
    });

    it('keeps read Mentions visible without counting them as fresh or moving them into Needs you', () => {
        const artifact = createAccountNoticeArtifactFixture({ header: { title: 'You were mentioned', type: 'mention', readAt: 2_000 } });
        const rows = buildInboxItems({ ...emptyInput, notices: [
            { artifact, header: AccountNoticeArtifactHeaderV1Schema.parse(artifact.rawHeader) },
        ] });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ view: 'mentions', type: 'mention', read: true });
    });

    it('retains the Automation attention owner Home instead of the ambient Account Home', async () => {
        const { createAutomationRunFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const run = createAutomationRunFixture({ id: 'run-1', automationId: 'automation-1', state: 'failed' });
        const row = { id: run.id, revision: run.revision, updatedAt: run.updatedAt, summary: null, metadata: null, automation: run };
        const rows = buildInboxItems({ ...emptyInput, workGroups: [{ key: 'automation:served-home:automation-1',
            root: { kind: 'automation', automationId: run.automationId, serverId: 'served-home', runId: run.id },
            items: [{ kind: 'automation_run', key: 'automation-run:run-1', row }],
        }] });
        expect(rows[0]).toMatchObject({ source: { serverId: 'served-home' }, focus: { serverId: 'served-home' } });
        expect(rows[0]?.pageRoute).toBe('/workflows/runs/run-1?target=occurrence&automationId=automation-1&serverId=served-home');
    });
    it('carries the current question handler and continue assumption from the same live request', async () => {
        const current = await input();
        const group = current.workGroups[0]!;
        const item = group.items[0]!;
        if (item.kind !== 'session') throw new Error('Expected Session fixture');
        const request = { id: 'question', kind: 'user_action' as const, tool: 'AskUserQuestion',
            arguments: {}, createdAt: 1_000, currentHandler: { kind: 'session' as const, sessionId: 'manager' },
            questionV1: { mode: 'continue' as const, assumption: 'Use the default', lasting: false } };
        const rows = buildInboxItems({ ...current, workGroups: [{ ...group, items: [{ ...item,
            entry: { ...item.entry, pendingPermissions: [], pendingUserActions: [request] } }] }] });
        expect(rows[0]).toMatchObject({ question: { requestId: 'question', mode: 'continue', assumption: 'Use the default',
            currentHandler: { kind: 'session', address: { serverId: 'home-a', sessionId: 'manager' } } } });
    });
});
