import { describe, expect, it } from 'vitest';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { selectSessionReportSubtree } from './reportSubtree';
import { getSessionName } from '@/utils/sessions/sessionUtils';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { readSessionWorkStatusFacts } from '@/components/work/status/sessionWorkStatusFacts';
import { resolveWorkStatusTone } from '@/components/work/status/resolveWorkStatusTone';

describe('selectSessionReportSubtree', () => {
    it('keeps the list status for unopened reports even when an opened transcript has a higher message sequence', () => {
        const nowMs = 1_000_000;
        const opened = createSessionFixture({ id: 'child', serverId: 'home-a', manager: { sessionId: 'lead' },
            seq: 20, active: true, activeAt: nowMs, latestTurnStatus: 'completed',
            latestTurnStatusObservedAt: nowMs - 1, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0 });
        const row = createSessionListRenderableSessionFixture({ id: 'child', manager: { sessionId: 'lead' },
            seq: 19, active: true, activeAt: nowMs, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: nowMs,
            agentStateVersion: opened.agentStateVersion + 1, hasPendingPermissionRequests: true, pendingRequestObservedAt: nowMs });
        const report = selectSessionReportSubtree({ child: opened }, 'lead', 'home-a', { 'home-a': { child: row } })[0]!;
        const present = (source: Parameters<typeof readSessionWorkStatusFacts>[0]) => resolveWorkStatusTone({ kind: 'session', facts: readSessionWorkStatusFacts(source, nowMs) });
        expect(present(row).bucket).toBe('needs_you');
        expect(present(report)).toEqual(present(row));
    });
    it('names unopened layout-v1 reports from the owner list projection', () => {
        const source = createSessionFixture({ id: 'child', manager: { sessionId: 'lead' }, metadataLayoutVersion: 1,
            metadata: null,
            ownerMetadataView: { name: 'Unopened report', path: '/repo', host: 'machine' } });
        const row = buildSessionListRenderableFromSession(source);
        const reports = selectSessionReportSubtree({}, 'lead', 'home-a', { 'home-a': { child: row } });
        expect(reports.map(session => getSessionName(session))).toEqual(['Unopened report']);
    });
    it('keeps the tree in its exact Home when lead and child ids collide across Homes', () => {
        const child = createSessionFixture({ id: 'child', serverId: 'home-a', manager: { sessionId: 'lead' } });
        const grandchild = createSessionFixture({ id: 'grandchild', serverId: 'home-a', manager: { sessionId: 'child' }, createdAt: 2 });
        const otherHome = createSessionFixture({ id: 'other', serverId: 'home-b', manager: { sessionId: 'lead' } });
        const crossHomeDescendant = createSessionFixture({ id: 'cross', serverId: 'home-b', manager: { sessionId: 'child' } });
        const unqualified = createSessionFixture({ id: 'unqualified', manager: { sessionId: 'lead' } });
        const sessions = { child, grandchild, otherHome, crossHomeDescendant, unqualified };
        expect(selectSessionReportSubtree(sessions, 'lead', 'home-a')).toEqual([child, grandchild]);
        expect(selectSessionReportSubtree(sessions, 'lead', 'home-b')).toEqual([otherHome]);
        expect(selectSessionReportSubtree(sessions, 'lead', null)).toEqual([]);
    });

    it('includes unopened reports from the qualified list without borrowing another Home or a stale opened relation', () => {
        const child = createSessionListRenderableSessionFixture({ id: 'child', manager: { sessionId: 'lead' } });
        const grandchild = createSessionListRenderableSessionFixture({ id: 'grandchild', manager: { sessionId: 'child' }, createdAt: 2 });
        const detached = createSessionListRenderableSessionFixture({ id: 'detached', manager: null });
        const state = {
            sessions: {
                child: createSessionFixture({ id: 'child', serverId: 'home-b', manager: { sessionId: 'other' } }),
                detached: createSessionFixture({ id: 'detached', serverId: 'home-a', manager: { sessionId: 'lead' } }),
            },
            sessionListRowsByServerId: { 'home-a': { child, grandchild, detached } },
        };
        const reports = selectSessionReportSubtree(state.sessions, 'lead', 'home-a', state.sessionListRowsByServerId);
        expect(reports.map((session) => [session.id, session.serverId, session.manager?.sessionId]))
            .toEqual([['child', 'home-a', 'lead'], ['grandchild', 'home-a', 'child']]);
        const next = selectSessionReportSubtree({ ...state.sessions, unrelated: createSessionFixture({ id: 'unrelated', serverId: 'home-a' }) },
            'lead', 'home-a', state.sessionListRowsByServerId);
        expect(next[0]).toBe(reports[0]);
        expect(next[1]).toBe(reports[1]);
    });
});
