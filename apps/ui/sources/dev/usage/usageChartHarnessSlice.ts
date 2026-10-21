import { normalizeUsageQuery, type UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsageHowYouWork, type UsageAcceptedInputFact } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import type { UsageClosedTurnFact, UsageWorkIntervalFact, UsageWorkPermissionFact } from '@happier-dev/protocol/usage/usageWorkIntervals';

/**
 * Development harness only (`/dev/usage-charts`): deterministic synthetic work facts pushed through the real How-you-work
 * owner, so the shared chart bodies can be judged beside the lab on an Account that has no witnessed busy time. These
 * numbers are fixtures, never product evidence.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AGENTS = ['claude', 'codex', 'gemini', 'opencode'] as const;
/** When each Agent tends to work (relative weight per hour of the day). */
const PROFILE: Readonly<Record<(typeof AGENTS)[number], (hour: number) => number>> = {
  claude: (hour) => (hour >= 9 && hour <= 19 ? 1 : hour >= 20 && hour <= 23 ? 0.45 : 0.06),
  codex: (hour) => (hour >= 9 && hour <= 18 ? 0.8 : hour <= 4 ? 0.6 : 0.2),
  gemini: (hour) => (hour >= 10 && hour <= 17 ? 0.6 : 0.03),
  opencode: (hour) => (hour >= 19 && hour <= 23 ? 0.7 : 0.05),
};
const TURNS_PER_DAY = { claude: 7, codex: 4, gemini: 2, opencode: 1.4 } as const;
const MEDIAN_MINUTES = { claude: 6, codex: 14, gemini: 3, opencode: 4.5 } as const;

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createUsageChartHarnessSlice(days = 90): Readonly<{ slice: UsageQueryResultSlice; query: UsageQuery }> {
  const random = seeded(20261021);
  const today = Math.floor(Date.now() / DAY) * DAY;
  const period = { startMs: today - (days - 1) * DAY, endMs: today + DAY };
  const facts: UsageWorkIntervalFact[] = [];
  const closedTurns: UsageClosedTurnFact[] = [];
  const permissions: UsageWorkPermissionFact[] = [];
  const acceptedInputs: UsageAcceptedInputFact[] = [];
  const activityAtMs: number[] = [];
  let id = 0;
  for (let day = 0; day < days; day++) {
    const dayStart = period.startMs + day * DAY;
    if (random() < 0.08) continue; // a few quiet days
    const intensity = 0.5 + random() * 1.1;
    for (const agentId of AGENTS) {
      const count = Math.round(TURNS_PER_DAY[agentId] * intensity * (0.4 + random()));
      for (let turn = 0; turn < count; turn++) {
        // Pick an hour by the Agent's profile, then a log-normal duration around its median.
        let hour = Math.floor(random() * 24);
        for (let attempt = 0; attempt < 6 && random() > PROFILE[agentId](hour); attempt++) hour = Math.floor(random() * 24);
        const startMs = dayStart + hour * HOUR + Math.floor(random() * HOUR);
        const minutes = MEDIAN_MINUTES[agentId] * Math.exp((random() + random() + random() - 1.5) * 1.6);
        const endMs = Math.min(period.endMs - 1, startMs + Math.max(20_000, Math.round(minutes * 60_000)));
        const workId = `harness-${agentId}-${++id}`;
        const open = day === days - 1 && turn === count - 1 && random() < 0.5;
        facts.push({ workId, evidenceId: `${workId}-busy`, agentId, machineId: null, kind: 'busy', startMs, endMs: open ? null : endMs });
        closedTurns.push({ workId, agentId, status: open ? 'in_progress' : 'completed', startMs, endMs: open ? null : endMs });
        activityAtMs.push(startMs);
        if (!open && random() < 0.18) {
          const waitStart = startMs + Math.floor((endMs - startMs) * 0.4);
          const waitEnd = Math.min(endMs, waitStart + Math.floor(30_000 + random() * 240_000));
          facts.push({ workId, evidenceId: `${workId}-wait`, agentId, machineId: null, kind: 'permission_wait', startMs: waitStart, endMs: waitEnd });
          const phone = random() < 0.35;
          permissions.push({ requestId: `${workId}-p`, workId, requestedAtMs: waitStart, decidedAtMs: waitEnd, toolId: 'shell',
            answeringClientCategory: phone ? (random() < 0.6 ? 'ios' : 'android') : 'desktop' });
        }
        if (!open && random() < 0.3) acceptedInputs.push({ inputId: `${workId}-s`, workId, turnId: `${workId}-t`,
          acceptedAtMs: startMs + Math.floor((endMs - startMs) / 2), deliveryKind: random() < 0.7 ? 'steer' : 'followUp' });
      }
    }
  }
  const query = normalizeUsageQuery({ period: { relative: '90days' }, metric: 'busy', timeZoneOffsetMinutes: 0 });
  const howYouWork = resolveUsageHowYouWork({ period, timeZoneOffsetMinutes: 0, nowMs: Date.now(), includeSteering: true, includeAgentCalendar: true,
    nightHours: { startHour: 23, endHour: 7 },
    detail: { status: 'available', facts, closedTurns, permissions, acceptedInputs, activityAtMs, collaboration: [] } });
  // Harness boundary: only the fields the chart bodies read are supplied; the rest of the Resource slice is not modelled.
  const slice = { key: 'usage-chart-harness', requestedQuery: query, shownQuery: query, howYouWork,
    sources: [{ source: 'accounting', status: 'available' }, { source: 'how_you_work', status: 'available' }, { source: 'work', status: 'available' }],
    mergedOutcomes: undefined } as unknown as UsageQueryResultSlice;
  return { slice, query };
}
