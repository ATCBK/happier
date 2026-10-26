import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionManagedSessionsV1Schema, type SessionManagedSessionsV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { selectSessionReportSubtree } from '@/components/sessions/work/reportSubtree';
import { readSessionWorkStatusFacts, readSessionWorkStalled } from '@/components/work/status/sessionWorkStatusFacts';
import { projectWork, groupWorkByState, readWorkWorkingCount } from '@/components/sessions/work/workProjection';
import { readSessionAwarenessPresentationV1, readSessionAwarenessWorkStatusV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';

import {
  SessionRowReportsChip,
  SessionRowReportsDisclosure,
} from './SessionRowReportsChip';

const REPORTS: SessionManagedSessionsV1 = { total: 3, needsYou: 1, working: 1, stalled: 0, finished: 0, attentionPrimary: null };

describe('SessionRowReportsChip', () => {
  afterEach(() => {
    standardCleanup();
  });

  it('agrees with real Work projection for the same offline in-progress list facts', async () => {
    const now = Date.now();
    const child = createSessionFixture({ id: 'child', serverId: 'home', manager: { sessionId: 'lead' },
      active: false, activeAt: now, presence: 0, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now });
    const row = buildSessionListRenderableFromSession(child);
    const reports = selectSessionReportSubtree({}, 'lead', 'home', { home: { child: row } });
    const awareness = readSessionWorkStatusFacts(row, now).awareness;
    const status = readSessionAwarenessWorkStatusV1({ awareness });
    const stalled = readSessionWorkStalled(row, now);
    // The rollup carries its strongest report state; the chip presents that state's count.
    const counts = SessionManagedSessionsV1Schema.parse({ total: 1, working: Number(status.bucket === 'working'), needsYou: Number(status.bucket === 'needs_you'), stalled: Number(stalled), finished: 0, attentionPrimary: readSessionAwarenessPresentationV1(awareness) });
    const work = projectWork({ sessionId: 'lead', reportSessions: reports.map(session => ({
      sessionId: session.id, managerSessionId: 'lead', title: 'Payment retries', agentId: null, facts: [],
      statusFacts: readSessionWorkStatusFacts(session, now), stalled: readSessionWorkStalled(session, now), archived: false,
    })), agentEntries: [], workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
      describeAgentStatus: () => '', describeProgress: () => '' });
    expect(groupWorkByState(work).recent.map(item => item.status.bucket)).toEqual(['offline']);
    expect(readWorkWorkingCount(work.summary)).toBe(0);
    const screen = await renderScreen(<SessionRowReportsChip sessionId="lead" reports={counts} />);
    expect(screen.getTextContent().toLowerCase()).not.toContain('working');
    expect(screen.getTextContent().toLowerCase()).toContain('offline');
  });

  it('keeps a folded lead quiet but truthful: the reports count, and the needs-you dot while one waits', async () => {
    const screen = await renderScreen(
      <SessionRowReportsChip
        sessionId="bot"
        reports={REPORTS}
        collapsed
      />,
    );
    expect(screen.getTextContent()).toContain('3');
    const settled = await renderScreen(
      <SessionRowReportsChip
        sessionId="bot"
        reports={{ total: 3, needsYou: 0, working: 0, stalled: 0, finished: 0, attentionPrimary: null }}
        collapsed
      />,
    );
    // Settled reports no longer hide behind an absent chip once they are folded away.
    expect(settled.findByTestId('session-row-reports-chip:bot')).not.toBeNull();
  });

  it('counts only the sub-sessions that are not archived, and says nothing when every report is archived', async () => {
    const counted = await renderScreen(
      <SessionRowReportsChip sessionId="bot" reports={{ total: 3, needsYou: 0, working: 0, stalled: 0, archived: 1, finished: 0, attentionPrimary: null }} collapsed />,
    );
    expect(counted.findByTestId('session-row-reports-chip:bot')?.props.accessibilityLabel).toContain('2');
    const archivedOnly = await renderScreen(
      <SessionRowReportsChip sessionId="bot" reports={{ total: 1, needsYou: 0, working: 0, stalled: 0, archived: 1, finished: 0, attentionPrimary: null }} collapsed />,
    );
    expect(archivedOnly.findByTestId('session-row-reports-chip:bot')).toBeNull();
  });

  it('writes the explicit opposite of the current fold for its own list node', async () => {
    const onSetCollapsed = vi.fn();
    const screen = await renderScreen(
      <SessionRowReportsDisclosure
        sessionId="bot"
        nodeId="session:home/bot"
        name="Release captain"
        count={3}
        collapsed
        onSetCollapsed={onSetCollapsed}
      />,
    );
    const control = screen.findByTestId('session-row-reports-disclosure:bot');
    expect(control?.props.accessibilityState).toMatchObject({
      expanded: false,
    });
    screen.pressByTestId('session-row-reports-disclosure:bot');
    expect(onSetCollapsed).toHaveBeenCalledWith('session:home/bot', false);

    const expanded = await renderScreen(
      <SessionRowReportsDisclosure
        sessionId="bot2"
        nodeId="session:home/bot2"
        name="Release captain"
        count={3}
        collapsed={false}
        onSetCollapsed={onSetCollapsed}
      />,
    );
    expanded.pressByTestId('session-row-reports-disclosure:bot2');
    expect(onSetCollapsed).toHaveBeenLastCalledWith('session:home/bot2', true);
  });
});
