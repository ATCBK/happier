import { describe, expect, it } from 'vitest';
import { AccountNoticeArtifactHeaderV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { DiscussionFollowUpdateNotificationV1Schema, RunFollowUpdateNotificationV1Schema } from '@happier-dev/protocol/activity/webhookPayload';


import { createInboxItemRoute, isFocusedInboxWorkItem, readInboxItemFocus, resolveInboxItemPageRoute } from './inboxItemFocus';

describe('Home-qualified Inbox focus', () => {
    it('opens a Discussion Follow notice at its exact committed message on the original Home', () => {
        const notice = DiscussionFollowUpdateNotificationV1Schema.parse({ topic: 'follow_update', follow: {
            original: { kind: 'discussion', discussion: { serverId: 'saved-home', discussionId: 'thread/7' }, messageId: 'message/3' },
            event: { kind: 'person_wrote' },
        } });
        const header = AccountNoticeArtifactHeaderV1Schema.parse({ v: 1, kind: 'account_notice.v1',
            source: { kind: 'host', topic: 'follow_update' }, type: 'update', resolved: false,
            title: 'Discussion update', status: 'open', notice,
        });
        expect(resolveInboxItemPageRoute({ kind: 'notice', serverId: 'different-home', id: 'notice-1' }, { notice: header }))
            .toBe('/discussions/thread%2F7?serverId=saved-home&messageId=message%2F3');
    });
    it.each([
        { original: { source: { kind: 'execution_run', sessionId: 'source-session', runId: 'run/7' }, terminalEventId: 'terminal-1' },
            route: '/session/source-session/runs/run%2F7?serverId=home-b' },
        { original: { source: { kind: 'workflow_run', runId: 'run/7' }, revision: 2 },
            route: '/workflows/runs/run%2F7?serverId=home-b' },
    ])('opens a Follow notice at its exact $original.source.kind result on the notice Home', ({ original, route }) => {
        const notice = RunFollowUpdateNotificationV1Schema.parse({ topic: 'follow_update', follow: {
            original, event: { kind: 'finished' },
        } });
        const header = AccountNoticeArtifactHeaderV1Schema.parse({ v: 1, kind: 'account_notice.v1',
            source: { kind: 'host', topic: 'follow_update' }, type: 'update', resolved: false,
            title: 'Run finished', status: 'open', notice,
        });
        expect(resolveInboxItemPageRoute({ kind: 'notice', serverId: 'home-b', id: 'notice-1' }, { notice: header })).toBe(route);
    });

    it('opens an Automation occurrence through the canonical Run route on the row Home', () => {
        const focus = { kind: 'automation_run', serverId: 'home-b', id: 'same-run', automationId: 'same-automation' } as const;
        expect(resolveInboxItemPageRoute(focus))
            .toBe('/workflows/runs/same-run?target=occurrence&automationId=same-automation&serverId=home-b');
    });
    it('opens the same qualified committed Discussion root as the Doc', () => {
        const focus = { kind: 'discussion', serverId: 'saved-home', id: 'same-thread', messageId: 'saved-root' } as const;
        const route = createInboxItemRoute(focus);
        expect(readInboxItemFocus(route.params.item)).toEqual(focus);
        expect(resolveInboxItemPageRoute(focus)).toBe('/discussions/same-thread?serverId=saved-home&messageId=saved-root');
        expect(readInboxItemFocus('discussion:saved-home:same-thread')).toBeNull();
    });
    it('round-trips an existing positive source jumpSeq anchor without inventing an anchor for missing context', () => {
        const focus = { kind: 'session', serverId: 'home-a', id: 'session-a', jumpSeq: 18 } as const;
        const route = createInboxItemRoute(focus);
        expect(readInboxItemFocus(route.params.item, undefined, route.params.jumpSeq)).toEqual(focus);
        expect(resolveInboxItemPageRoute(focus)).toBe('/session/session-a?serverId=home-a&jumpSeq=18');
        for (const invalid of [undefined, '0', '-1', 'NaN', '1.5']) {
            expect(readInboxItemFocus(route.params.item, undefined, invalid)).toEqual({ kind: 'session', serverId: 'home-a', id: 'session-a' });
        }
    });

    it('selects only the qualified Session when two Homes have the same id', async () => {
        const { buildActivityOverviewSnapshot } = await import('@/activity/attention/buildActivityOverviewSnapshot');
        const { buildInboxSessionPresentation } = await import('@/activity/presentation/buildInboxSessionPresentation');
        const { buildInboxWorkGroups } = await import('@/activity/presentation/buildInboxWorkGroups');
        const { createSessionFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
        const sessions = ['home-a', 'home-b'].map((serverId) => createSessionFixture({
            id: 'same-session', serverId, active: true, pendingPermissionRequestCount: 1, pendingRequestObservedAt: 1_000,
        }));
        const presentation = buildInboxSessionPresentation({ overview: buildActivityOverviewSnapshot({ sessions, nowMs: 1_000 }) });
        const items = buildInboxWorkGroups({ sessionEntries: presentation.sessionsNeedingAttention,
            workflowRuns: [], automationRuns: [], automationServerId: null, openApprovals: [],
            stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null,
        }).flatMap((group) => group.items);
        expect(items).toHaveLength(2);
        const focus = readInboxItemFocus(createInboxItemRoute({ kind: 'session', serverId: 'home-b', id: 'same-session' }).params.item);
        expect(items.filter((item) => isFocusedInboxWorkItem(item, focus)).map((item) => item.key)).toEqual(['session:home-b:same-session']);
    });

    it('round-trips qualified ids and refuses ambiguous legacy or malformed input', () => {
        const focus = { kind: 'session', serverId: 'https://home.example/a:b', id: 'session:with/parts' } as const;
        const route = createInboxItemRoute(focus);
        expect(readInboxItemFocus([route.params.item])).toEqual(focus);
        for (const value of [undefined, '', 'session:legacy', 'run:legacy', 'session::id', 'run:home:', 'session:%XX:id', 'session:home:id:extra']) {
            expect(readInboxItemFocus(value)).toBeNull();
        }
    });

    it('addresses an approval by its artifact, with its Home when the request names one', () => {
        for (const focus of [
            { kind: 'approval', serverId: 'home-a', id: 'artifact:1' },
            { kind: 'approval', serverId: '', id: 'artifact-2' },
        ] as const) {
            expect(readInboxItemFocus(createInboxItemRoute(focus).params.item)).toEqual(focus);
        }
        expect(readInboxItemFocus('approval:home-a:')).toBeNull();
    });

    it('compares the workflow Run focus against the Home that serves the Inbox window', async () => {
        const { createWorkflowRunSummaryFixture } = await import('@/dev/testkit/fixtures/workflowRunFixtures');
        const { workflowRunRowFromSummary } = await import('@/sync/store/domains/workflowRuns');
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'same-run' }), null);
        const item = { kind: 'workflow_run', key: 'run:same-run', runId: 'same-run', row,
            heldStepLabel: null, heldStepLaneLabel: null } as const;
        const focus = readInboxItemFocus(createInboxItemRoute({ kind: 'workflow_run', serverId: 'home-b', id: 'same-run' }).params.item);
        expect(isFocusedInboxWorkItem(item, focus, 'home-a')).toBe(false);
        expect(isFocusedInboxWorkItem(item, focus, 'home-b')).toBe(true);
        expect(isFocusedInboxWorkItem(item, focus, null)).toBe(false);
    });

    it('retains an exact held invocation when opening a Run beside the Inbox', () => {
        const focus = { kind: 'workflow_run', serverId: 'home-a', id: 'run-a',
            invocationId: '33333333-3333-4333-8333-333333333333' } as const;
        const route = createInboxItemRoute(focus);
        expect(readInboxItemFocus(route.params.item, route.params.invocationId)).toEqual(focus);
    });

    it('retains a notice Artifact selection without putting plugin routing authority in the URL', () => {
        expect(readInboxItemFocus('notice:home-a:artifact-42')).toEqual({ kind: 'notice', serverId: 'home-a', id: 'artifact-42' });
    });
});
