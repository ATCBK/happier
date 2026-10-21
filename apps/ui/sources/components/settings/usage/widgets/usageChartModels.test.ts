import { describe, expect, it } from 'vitest';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectUsageAgentShares, projectUsageConstellationModel, projectUsageDaylight, projectUsageSkyModel, projectUsageWeekHours, type UsageAgentCalendar } from './usageChartModels';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';

const DAY = 86_400_000;
const START = Date.UTC(2026, 8, 7); // Monday 7 Sep 2026, UTC calendar
type Metrics = UsageAgentCalendar['days'][number]['totals'];
const metrics = (values: Partial<Metrics>): Metrics => ({ tokens: null, eventCount: null, sessions: null, cost: null, busyMs: null, steeringCount: null,
  peakParallel: null, ...values });
const coverage = { accounting: 'complete_for_supplied_facts', busy: 'complete_for_supplied_facts', steering: 'complete_for_supplied_facts' } as const;
type Leader = UsageAgentCalendar['days'][number]['leaders']['tokens'];
const none: Leader = { status: 'unavailable', agentIds: [], includesUnknown: false };
const leaders = (overrides: Partial<Record<keyof Metrics, Leader>> = {}) => ({ tokens: none, eventCount: none, sessions: none, cost: none, busyMs: none,
  steeringCount: none, peakParallel: none, ...overrides });
const bucket = (dayIndex: number, totals: Partial<Metrics>, agents: readonly [string | null, Partial<Metrics>][] = [], leaderOverrides = {}, hour: number | null = null) => {
  const startMs = START + dayIndex * DAY + (hour ?? 0) * 3_600_000;
  return { startMs, endMs: startMs + (hour === null ? DAY : 3_600_000), date: new Date(START + dayIndex * DAY).toISOString().slice(0, 10),
    weekday: new Date(START + dayIndex * DAY).getUTCDay(), hour, totals: metrics(totals),
    agents: agents.map(([agentId, values]) => ({ agentId, metrics: metrics(values), coverage })), leaders: leaders(leaderOverrides) };
};
const calendar = (input: Partial<UsageAgentCalendar>): UsageAgentCalendar => ({
  period: { startMs: START, endMs: START + 5 * DAY }, timeZoneOffsetMinutes: 0, costMode: 'auto', coverage, days: [], weeks: [], hours: [], weekdayHourBuckets: [], hourOfDayBuckets: [],
  periodSummary: { totals: metrics({}), agents: [], leaders: leaders() },
  agentActiveDays: [], weeklyAgentMix: [], weeklyPeakParallel: [], dayNightActivity: null, machineKinds: { status: 'unavailable', reason: 'no_witnessed_kind' },
  ...input,
} satisfies UsageAgentCalendar);

describe('Usage chart models', () => {
  it('reads the selected metric on Sky of days and keeps ties, unattributed and unrecorded days distinct', () => {
    const model = projectUsageSkyModel(calendar({ days: [
      bucket(0, { tokens: 900, steeringCount: 4, eventCount: 3 }, [], { steeringCount: { status: 'leading', agentIds: ['codex'], includesUnknown: false } }),
      bucket(1, { tokens: 10, steeringCount: 2, eventCount: 2 }, [], { steeringCount: { status: 'tied', agentIds: ['claude', 'codex'], includesUnknown: false } }),
      bucket(2, { tokens: 50, steeringCount: 1, eventCount: 1 }, [], { steeringCount: { status: 'unattributed', agentIds: [], includesUnknown: true } }),
      bucket(3, { tokens: 70, steeringCount: null, eventCount: 1 }),
    ] }), 'steering', 'leadingAgent', START + 4 * DAY);
    expect(model.days.map((day) => [day.state, day.value ?? null, day.leader ?? null])).toEqual([
      ['active', 4, { kind: 'agent', agentId: 'codex' }],
      ['active', 2, { kind: 'tie', agentIds: ['claude', 'codex'] }],
      ['active', 1, { kind: 'unknown' }],
      // A day whose steering is not known is not a quiet day.
      ['unknown', null, null],
      ['inactive', null, null],
    ]);
  });

  it('gives a context-only Agent an unknown share instead of zero and keeps unknown attribution in the denominator', () => {
    const shares = projectUsageAgentShares(calendar({ periodSummary: { totals: metrics({ tokens: 400 }), leaders: leaders(), agents: [
      { agentId: 'claude', metrics: metrics({ tokens: 300 }), coverage, shares: { tokens: 0.75, cost: null } },
      { agentId: 'pi', metrics: metrics({ tokens: null }), coverage, shares: { tokens: null, cost: null } },
      { agentId: null, metrics: metrics({ tokens: 100 }), coverage, shares: { tokens: 0.25, cost: null } },
    ] }, days: [
      bucket(0, { tokens: 400 }, [['claude', { tokens: 300 }], ['pi', { tokens: null, eventCount: 4 }], [null, { tokens: 100 }]]),
    ] }), 'tokens');
    expect(shares).toEqual([
      { agentId: 'claude', share: 0.75, activeDays: null },
      { agentId: 'pi', share: null, activeDays: null },
    ]);
  });

  it('reads full-period membership and shares rather than deriving them from calendar day sums', () => {
    const usd = (amountUsd: number) => ({ amountUsd, currency: 'USD', source: 'provider', kind: 'reported' as const });
    const shares = projectUsageAgentShares(calendar({
      days: [bucket(0, { tokens: 100, cost: usd(100) }, [['claude', { tokens: 100, cost: usd(100) }]])],
      periodSummary: { totals: metrics({ tokens: 400, cost: usd(40) }), leaders: leaders(), agents: [
        { agentId: 'claude', metrics: metrics({ tokens: 300, cost: usd(30) }), coverage, shares: { tokens: 0.75, cost: 0.75 } },
        { agentId: 'codex', metrics: metrics({ tokens: 100, cost: usd(10) }), coverage, shares: { tokens: 0.25, cost: 0.25 } },
      ] }, agentActiveDays: [{ agentId: 'codex', days: 2, coverage: 'partial' }],
    }), 'cost');
    expect(shares).toEqual([
      { agentId: 'claude', share: 0.75, activeDays: null },
      { agentId: 'codex', share: 0.25, activeDays: 2 },
    ]);
  });

  it('does not sum Sessions or peak parallel across hours, which would double count', () => {
    const value = calendar({ hours: [bucket(0, { busyMs: 600_000, sessions: 3, peakParallel: 3 }, [], {}, 9),
      bucket(7, { busyMs: 300_000, sessions: 2, peakParallel: 2 }, [], {}, 9)], weekdayHourBuckets: [{
        weekday: 1, hour: 9, totals: metrics({ busyMs: 900_000, sessions: 4, peakParallel: 3 }), agents: [], leaders: leaders(),
      }] });
    expect(projectUsageWeekHours(value, 'sessions')!.grid[0]![9]).toBe(4);
    expect(projectUsageWeekHours(value, 'peakParallel')!.grid[0]![9]).toBe(3);
    // Monday first; the canonical owner supplies each metric's actual reduction.
    expect(projectUsageWeekHours(value, 'busy')!.grid[0]![9]).toBe(900_000);
  });

  it('preserves unknown weekday cells instead of painting partial history as measured zero', () => {
    const value = calendar({ coverage: { ...coverage, accounting: 'partial' },
      hours: [bucket(0, { tokens: 5 }, [], {}, 9), bucket(0, { tokens: null }, [], {}, 10)],
      weekdayHourBuckets: [
        { weekday: 1, hour: 9, totals: metrics({ tokens: 5 }), agents: [], leaders: leaders() },
        { weekday: 1, hour: 10, totals: metrics({ tokens: null }), agents: [], leaders: leaders() },
      ] });
    const model = projectUsageWeekHours(value, 'tokens')!;
    expect(model.grid[0]![9]).toBe(5);
    expect(model.grid[0]![10]).toBeNull();
    expect(model.grid[0]![11]).toBeNull();
  });

  it('uses the canonical typical-hour Sessions and peak instead of summing weekday counts', () => {
    const slice = resolveUsagePageAggregation({ queries: [normalizeUsageQuery({ period: { startMs: START, endMs: START + 8 * DAY } })] }).results[0]!;
    const value = calendar({ weekdayHourBuckets: [
      { weekday: 1, hour: 9, totals: metrics({ sessions: 3, peakParallel: 3 }), agents: [], leaders: leaders() },
      { weekday: 2, hour: 9, totals: metrics({ sessions: 2, peakParallel: 2 }), agents: [], leaders: leaders() },
    ], hourOfDayBuckets: [{ hour: 9, totals: metrics({ sessions: 4, peakParallel: 3 }), agents: [], leaders: leaders() }] });
    expect(projectUsageDaylight(value, 'sessions', slice)!.hours[9]).toBe(4);
    expect(projectUsageDaylight(value, 'peakParallel', slice)!.hours[9]).toBe(3);
    const partial = calendar({ coverage: { ...coverage, accounting: 'partial' },
      weekdayHourBuckets: [{ weekday: 1, hour: 9, totals: metrics({ tokens: 5 }), agents: [], leaders: leaders() }],
      hourOfDayBuckets: [{ hour: 9, totals: metrics({ tokens: 5 }), agents: [], leaders: leaders() }] });
    expect(projectUsageDaylight(partial, 'tokens', slice)!.hours[10]).toBeNull();
  });

  it('keeps the private busy-window share on the plotted observed Agent-time basis', () => {
    const query = normalizeUsageQuery({ period: { startMs: START, endMs: START + DAY }, includeActivity: true });
    const hour = 3_600_000;
    const slice = resolveUsagePageAggregation({ queries: [query], nightHours: { startHour: 0, endHour: 1 },
      howYouWork: [{ query, detail: { status: 'partial', facts: [
        { workId: 'night-a', evidenceId: 'night-a', agentId: 'a', machineId: null, kind: 'busy', startMs: START, endMs: START + hour },
        { workId: 'night-b', evidenceId: 'night-b', agentId: 'b', machineId: null, kind: 'busy', startMs: START, endMs: START + hour },
        { workId: 'day-a', evidenceId: 'day-a', agentId: 'a', machineId: null, kind: 'busy', startMs: START + 12 * hour, endMs: START + 13 * hour },
      ] } }],
    }).results[0]!;
    const model = projectUsageDaylight(slice.howYouWork!.agentCalendar!, 'busy', slice)!;
    expect(model.hours[0]).toBe(2 * hour);
    expect(model.hours[12]).toBe(hour);
    expect(model.night?.share).toBeCloseTo(2 / 3);
  });

  it('draws only collaboration between Agents and says when no collaboration summary exists', () => {
    const slice = (collaboration: unknown) => ({ howYouWork: { collaboration } }) as unknown as UsageQueryResultSlice;
    const model = projectUsageConstellationModel(slice({ coverage: 'partial', unknownTimestampCount: 0, unknownSourceAgentCount: 3, unknownTargetAgentCount: 0, edges: [
      { sourceAgentId: 'claude', targetAgentId: 'codex', relation: 'run', count: 5 },
      { sourceAgentId: 'claude', targetAgentId: 'codex', relation: 'review', count: 2 },
      { sourceAgentId: 'claude', targetAgentId: 'codex', relation: 'handoff', count: 9 },
      { sourceAgentId: null, targetAgentId: 'codex', relation: 'spawn', count: 1 },
    ] }), []);
    expect(model.edges).toEqual([{ from: 'claude', to: 'codex', kind: 'run', count: 7 }]);
    expect(model.unknownStarts).toBe(3);
    expect(projectUsageConstellationModel(slice(null), [{ agentId: 'claude', share: 1 }]).edges).toBeNull();
  });
});
