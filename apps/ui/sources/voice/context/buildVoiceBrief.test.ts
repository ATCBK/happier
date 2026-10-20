import { describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { buildActivityOverviewFromCandidates, buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import type { WorkflowAttentionSource } from '@/hooks/inbox/useWorkflowAttentionSource';
import { buildVoiceBrief, type VoiceBriefSource } from './buildVoiceBrief';
import { createWorkflowRunSummaryFixture, createAutomationRunFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { buildInboxSessionContextLine } from '@/components/inbox/workGroups/inboxSessionContextLine';
import { t } from '@/text';
import { WorkflowRunPrivateMetadataV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { readInboxSessionTitle } from '@/components/inbox/sessionAttention/inboxSessionPrivacy';

const EMPTY_WORKFLOW_ATTENTION_SOURCE: WorkflowAttentionSource = { serverId: null, available: false, phase: 'idle', runIds: [], refreshFailed: false,
    knownAt: null, hasMore: false, loadingMore: false, loadMoreFailed: false, retry: async () => {}, loadMore: async () => {} };

function source(): VoiceBriefSource {
    const candidates = [
        ['failed', 'failed'], ['needs', 'permission_required'], ['ready', 'ready_after_read'],
    ].map(([id, reason]) => buildSessionActivityAttention({
        session: createSessionFixture({ id, serverId: 'home-a', latestTurnStatus: 'completed',
            metadata: { path: '/home/alice/private', host: 'test-host', summary: { text: `${id} /home/alice/private`, updatedAt: 1 } },
            viewer: { readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: null },
                relevance: { relevant: true, reasons: ['owned_by_me'] }, follow: { follows: false, notificationLevel: null, includeInVoice: true },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: [reason as 'failed' | 'permission_required' | 'ready_after_read'],
                    primary: reason as 'failed' | 'permission_required' | 'ready_after_read', presentation: 'full' } },
        }), nowMs: 1000,
    }));
    return {
        source: { isDataReady: true, personalSessionListCoverageComplete: true,
            sessionListHomeObservationByServerId: { 'home-a': { phase: 'ready', lastSuccessAt: 900 } } },
        sessionPresentation: buildInboxSessionPresentation({ overview: buildActivityOverviewFromCandidates(candidates) }),
        workGroups: [], automationAttentionItems: [], isLoading: false, showCaughtUp: false,
        workflowAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE, automationAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE,
    };
}

describe('Voice brief from the mounted Inbox', () => {
    it.each([
        { total: 2, working: 0, needsYou: 0, stalled: 2 },
        { total: 2, working: 0, needsYou: 2, stalled: 0 },
        { total: 6, working: 2, needsYou: 1, stalled: 3 },
    ])('keeps report buckets truthful in the spoken session context: %j', (reports) => {
        const inbox = source();
        const candidates = [...inbox.sessionPresentation.sessionsNeedingAttention.map(entry => entry.candidate),
            ...inbox.sessionPresentation.readySessions].map(candidate => ({ ...candidate, session: { ...candidate.session, managedSessions: reports } }));
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation: buildInboxSessionPresentation({
            overview: buildActivityOverviewFromCandidates(candidates),
        }) }, settings: { voice: { privacy: { shareSessionSummary: true } } } });
        expect(brief.items).toHaveLength(3);
        for (const item of brief.items) {
            expect(item.subtitle).not.toContain(t('sessionWork.strip.stillWorking', { count: reports.total }));
            if (reports.working > 0) expect(item.subtitle).toContain(t('sessionWork.strip.stillWorking', { count: reports.working }));
        }
        expect(brief.context).not.toContain(t('sessionWork.strip.stillWorking', { count: reports.total }));
    });
    it('keeps originless workflow and automation work at their exact existing Run routes', () => {
        const inbox = source();
        const row = { ...workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'run/a', state: 'interrupted' })),
            metadata: WorkflowRunPrivateMetadataV1Schema.parse({ kind: 'available', value: { title: 'Publish release notes' } }) };
        const route = '/workflows/runs/run%2Fb?target=occurrence&automationId=automation' as const;
        const brief = buildVoiceBrief({ inbox: { ...inbox,
            workflowAttention: { ...inbox.workflowAttention, serverId: 'home-b' },
            workGroups: buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
                openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null }),
            automationAttentionItems: [{ key: 'automation:run/b', title: 'Nightly dependency check', run: createAutomationRunFixture({ id: 'run/b', state: 'dispatch_failed' }), route }] }, settings: {} });
        expect(brief.items.find((item) => item.destination.kind === 'workflow')).toMatchObject({ title: 'Publish release notes', destination: { kind: 'workflow', runId: 'run/a' }, route: '/workflows/runs/run%2Fa?serverId=home-b' });
        expect(brief.items.find((item) => item.destination.kind === 'automation')).toMatchObject({ title: 'Nightly dependency check', destination: { kind: 'automation', route }, route });
        expect(brief.items).toHaveLength(5);
    });
    it('uses the Inbox’s readable session identity even when notification previews are status-only', () => {
        const inbox = source();
        const sessions = [...inbox.sessionPresentation.sessionsNeedingAttention.map(entry => entry.candidate.session),
            ...inbox.sessionPresentation.readySessions.map(candidate => candidate.session)].map(session => createSessionFixture({
                ...session, viewer: { ...session.viewer!, attention: { ...session.viewer!.attention, presentation: 'status_only' } },
            }));
        const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewSnapshot({ sessions, nowMs: 1000 }) });
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation }, settings: { voice: { privacy: { shareSessionSummary: true } } } });
        expect(brief.items).toHaveLength(3);
        for (const session of sessions) {
            const item = brief.items.find(item => item.destination.kind === 'session' && item.destination.address.sessionId === session.id);
            expect(item?.title)
                .toBe(readInboxSessionTitle(session, session.serverId ?? null, 1000));
            const candidate = [...sessionPresentation.sessionsNeedingAttention.map(entry => entry.candidate), ...sessionPresentation.readySessions]
                .find(candidate => candidate.sessionId === session.id)!;
            expect(item?.subtitle).toBe(buildInboxSessionContextLine(candidate));
        }
        expect(JSON.parse(brief.context).items.every((item: { title?: string }) => item.title === undefined)).toBe(true);
    });
    it('omits unreadable or unnamed work without claiming the Inbox is caught up', () => {
        const inbox = source();
        const original = inbox.sessionPresentation.readySessions[0]!.session;
        const sessions = [createSessionFixture({ ...original, id: 'locked', encryptionMode: 'e2ee', encryptedContentAvailability: 'encrypted_access_pending', metadata: null }),
            createSessionFixture({ ...original, id: 'unnamed', metadata: null })];
        const row = workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ id: 'unnamed-run', state: 'interrupted' }));
        const route = '/workflows/runs/unnamed-automation-run?target=occurrence&automationId=automation' as const;
        const brief = buildVoiceBrief({ inbox: { ...inbox,
            sessionPresentation: buildInboxSessionPresentation({ overview: buildActivityOverviewSnapshot({ sessions, nowMs: 1000 }) }),
            workGroups: buildInboxWorkGroups({ sessionEntries: [], workflowRuns: [row], automationRuns: [], automationServerId: null,
                openApprovals: [], stalledSessions: [], landings: [], snoozed: [], resolveSession: () => null, resolveOriginRunId: () => null }),
            automationAttentionItems: [{ key: 'unnamed-automation-run', run: createAutomationRunFixture(), route }] }, settings: {} });
        expect(brief.items).toEqual([]);
        expect(JSON.parse(brief.context).items).toEqual([]);
        expect(brief.caughtUp).toBe(false);
    });
    it('orders existing attention without losing exact Home destinations or reclassifying ready work', () => {
        const brief = buildVoiceBrief({ inbox: source(), settings: { voice: { privacy: { shareSessionSummary: true } } } });
        expect(brief.items.map((item) => item.category)).toEqual(['needs_you', 'failed', 'ready']);
        expect(brief.items.map((item) => item.destination)).toEqual([
            { kind: 'session', address: { serverId: 'home-a', sessionId: 'needs' } },
            { kind: 'session', address: { serverId: 'home-a', sessionId: 'failed' } },
            { kind: 'session', address: { serverId: 'home-a', sessionId: 'ready' } },
        ]);
        expect(brief.freshness.sessionHomes).toEqual({ 'home-a': { phase: 'ready', lastSuccessAt: 900 } });
    });

    it('carries the Inbox row’s own second line for each session it lists, so the brief says more than titles', () => {
        const inbox = source();
        const brief = buildVoiceBrief({ inbox, settings: {} });
        const candidates = [
            ...inbox.sessionPresentation.sessionsNeedingAttention.map((entry) => entry.candidate),
            ...inbox.sessionPresentation.readySessions,
        ];
        for (const item of brief.items) {
            const candidate = candidates.find((entry) => item.destination.kind === 'session' && entry.sessionId === item.destination.address.sessionId);
            const expected = candidate ? buildInboxSessionContextLine(candidate) : undefined;
            expect(expected).toBeTruthy();
            expect(item.subtitle).toBe(expected);
        }
    });

    it('withholds titles, destinations and request details from speech unless the canonical privacy policy admits them', () => {
        const inbox = source();
        const brief = buildVoiceBrief({ inbox, settings: { voice: { privacy: { shareSessionSummary: false, sharePermissionRequests: false } } } });
        expect(brief.items).toHaveLength(3);
        expect(brief.context).not.toContain('private');
        expect(brief.context).not.toContain('home-a');
        expect(brief.context).not.toContain('permission_required');
        const allowed = buildVoiceBrief({ inbox, settings: { voice: { privacy: { shareSessionSummary: true } } } });
        expect(JSON.parse(allowed.context).items.map((item: { title?: string }) => item.title)).toEqual([
            'needs <path_redacted>', 'failed <path_redacted>', 'ready <path_redacted>',
        ]);
        expect(allowed.context).not.toContain('/home/alice');
    });

    it('retains paging/failure facts and never announces caught up from unknown or partial sources', () => {
        const inbox = source();
        const brief = buildVoiceBrief({ inbox: { ...inbox, sessionPresentation: { sessionsNeedingAttention: [], readySessions: [], markAllReadTargets: [], pendingRequestHydrationTargets: [] },
            isLoading: true, showCaughtUp: true, source: { isDataReady: false, personalSessionListCoverageComplete: false },
            workflowAttention: { ...EMPTY_WORKFLOW_ATTENTION_SOURCE, available: true, phase: 'loaded', refreshFailed: true, knownAt: 700, hasMore: true } }, settings: {} });
        expect(brief.caughtUp).toBe(false);
        expect(brief.incomplete).toBe(true);
        expect(brief.freshness.workflow).toMatchObject({ knownAt: 700, refreshFailed: true, hasMore: true });
    });
});
