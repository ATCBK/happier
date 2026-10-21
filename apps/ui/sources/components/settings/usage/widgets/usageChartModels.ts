import type {
  UsageAgentShare, UsageDayModel, UsageRunLengthModel, UsageScoreModel, UsageShippedModel, UsageSkyDay, UsageSkyModel,
  UsageSteeringTideModel, UsageConstellationModel, UsageRiverModel, UsageWeekHourModel, UsageDaylightModel,
} from '@happier-dev/plugin-ui/presentation';
import type { UsageHowYouWork } from '@happier-dev/protocol/usage/resolveUsageHowYouWork';
import type { UsageQueryResultSlice } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { resolveUsageDayStreaks } from '@happier-dev/protocol/usage/usageActivitySummary';
import { resolveUsageCalendarInstant } from '@happier-dev/protocol/usage/usageCalendar';
import { isUsageNightHour } from '@happier-dev/protocol/usage/usageWorkIntervals';
import type { UsageChartMetric } from './usageChartHost';

/**
 * Private Usage → chart body models. Every figure comes from its canonical owner in the admitted slice
 * (`howYouWork.agentCalendar`, `intervals`, `steering`, `runLengths`, `collaboration`, `mergedOutcomes`); these
 * adapters only place and label them. A fact the owner does not supply stays null/unknown, never zero.
 */

/** The Agent calendar owner's result as the query carries it. */
export type UsageAgentCalendar = NonNullable<UsageHowYouWork['agentCalendar']>;
type CalendarBucket = UsageAgentCalendar['days'][number];
type CalendarMetrics = CalendarBucket['totals'];
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const METRIC_FIELDS = { tokens: 'tokens', cost: 'cost', sessions: 'sessions', busy: 'busyMs', steering: 'steeringCount', peakParallel: 'peakParallel' } as const;

export function readUsageCalendarMetric(metrics: CalendarMetrics, metric: UsageChartMetric): number | null {
  if (metric === 'cost') return metrics.cost?.amountUsd ?? null;
  return metrics[METRIC_FIELDS[metric]] as number | null;
}

/** Normalizes the query's presentation metric to a chart measure (an unknown value is never read as tokens). */
export function resolveUsageChartMetric(metric: string | undefined, fallback: UsageChartMetric): UsageChartMetric {
  return metric === 'tokens' || metric === 'cost' || metric === 'sessions' || metric === 'busy' || metric === 'steering' || metric === 'peakParallel' ? metric : fallback;
}

/** Every calendar date of the owner's period, oldest first (the owner lists only days it has facts for). */
function periodDates(calendar: UsageAgentCalendar): string[] {
  const dates: string[] = [];
  const offset = calendar.timeZoneOffsetMinutes;
  const first = resolveUsageCalendarInstant(calendar.period.startMs, offset);
  for (let start = first.bucketStartMs; start < calendar.period.endMs; start += DAY_MS) dates.push(resolveUsageCalendarInstant(start, offset).date);
  return dates;
}

export function projectUsageSkyModel(calendar: UsageAgentCalendar, metric: UsageChartMetric, colourBy: 'intensity' | 'leadingAgent', referenceMs: number): UsageSkyModel {
  const byDate = new Map(calendar.days.map((bucket) => [bucket.date, bucket]));
  const dates = periodDates(calendar);
  const field = METRIC_FIELDS[metric];
  const days: UsageSkyDay[] = dates.map((date) => {
    const bucket = byDate.get(date);
    if (!bucket) return { date, state: 'inactive' };
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value === null) return { date, state: 'unknown' };
    if (value <= 0) return { date, state: 'inactive', value: 0 };
    const leader = bucket.leaders[field];
    return { date, state: 'active', value,
      leader: leader.status === 'leading' && leader.agentIds[0] ? { kind: 'agent', agentId: leader.agentIds[0] }
        : leader.status === 'tied' && leader.agentIds.length >= 2 ? { kind: 'tie', agentIds: [leader.agentIds[0]!, leader.agentIds[1]!, ...leader.agentIds.slice(2)] }
        : leader.status === 'unattributed' || (leader.status === 'tied' && leader.agentIds.length < 2) ? { kind: 'unknown' } : null };
  });
  // Streak lengths come from the shared day-streak owner; their positions are the matching runs of active days.
  const streaks = resolveUsageDayStreaks({ referenceMs, timeZoneOffsetMinutes: calendar.timeZoneOffsetMinutes,
    range: calendar.period, days: dates.map((date) => ({ date, eventCount: byDate.get(date)?.totals.eventCount ?? 0 })) });
  const runs: { startDate: string; endDate: string; days: number }[] = [];
  let start: number | null = null;
  dates.forEach((date, index) => {
    const active = (byDate.get(date)?.totals.eventCount ?? 0) > 0;
    if (active && start === null) start = index;
    if ((!active || index === dates.length - 1) && start !== null) {
      const end = active ? index : index - 1;
      runs.push({ startDate: dates[start]!, endDate: dates[end]!, days: end - start + 1 });
      start = null;
    }
  });
  const best = streaks.longestStreakDays ? [...runs].reverse().find((run) => run.days === streaks.longestStreakDays) ?? null : null;
  const last = runs[runs.length - 1];
  const current = streaks.currentStreakDays && last && last.days === streaks.currentStreakDays ? last : null;
  return { encoding: 'amount', days, colourBy, best, current };
}

function emptyCalendarMetric(calendar: UsageAgentCalendar, metric: UsageChartMetric): number | null {
  const coverage = metric === 'busy' || metric === 'peakParallel' ? calendar.coverage.busy
    : metric === 'steering' ? calendar.coverage.steering : calendar.coverage.accounting;
  // Complete absence proves no recorded quantity, but does not supply a monetary basis.
  return coverage === 'complete_for_supplied_facts' && metric !== 'cost' ? 0 : null;
}

/** Monday-first 7×24; the canonical owner already resolves each measure's reduction and coverage. */
export function projectUsageWeekHours(calendar: UsageAgentCalendar, metric: UsageChartMetric): UsageWeekHourModel | null {
  const empty = emptyCalendarMetric(calendar, metric);
  const grid = Array.from({ length: 7 }, () => Array.from<number | null>({ length: 24 }).fill(empty));
  let known = empty === 0;
  for (const bucket of calendar.weekdayHourBuckets) {
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value !== null) known = true;
    const row = (bucket.weekday + 6) % 7;
    grid[row]![bucket.hour] = value;
  }
  return known ? { encoding: 'amount', grid } : null;
}

export function projectUsageDaylight(calendar: UsageAgentCalendar, metric: UsageChartMetric, slice: UsageQueryResultSlice): UsageDaylightModel | null {
  const empty = emptyCalendarMetric(calendar, metric);
  const hours = Array.from<number | null>({ length: 24 }).fill(empty);
  let known = empty === 0;
  for (const bucket of calendar.hourOfDayBuckets) {
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value !== null) known = true;
    hours[bucket.hour] = value;
  }
  if (!known) return null;
  const window = slice.howYouWork?.nightShift ?? null;
  // Keep the private observed Agent-time share on the same basis as these columns,
  // not the separate elapsed busy union. Public Q17 retains its recorded-activity owner.
  const busyTotal = metric === 'busy' ? calendar.hourOfDayBuckets.reduce((sum, bucket) => sum + (bucket.totals.busyMs ?? 0), 0) : 0;
  const nightBusy = window && metric === 'busy' ? calendar.hourOfDayBuckets.reduce((sum, bucket) =>
    sum + (isUsageNightHour(bucket.hour, window) ? bucket.totals.busyMs ?? 0 : 0), 0) : 0;
  const share = window && busyTotal > 0 ? nightBusy / busyTotal : null;
  return { encoding: 'amount', hours, night: window ? { fromHour: window.startHour, toHour: window.endHour, share } : null };
}

/** The actual day shown: the chosen `day`, else the period's busiest day by witnessed peak. */
export function resolveUsageChartDay(calendar: UsageAgentCalendar, day: string | undefined): CalendarBucket | null {
  if (day) return calendar.days.find((bucket) => bucket.date === day) ?? null;
  let best: CalendarBucket | null = null;
  for (const bucket of calendar.days) if ((bucket.totals.peakParallel ?? 0) > (best?.totals.peakParallel ?? 0)) best = bucket;
  return best;
}

const DAY_BINS = 96;
export function projectUsageDayModel(slice: UsageQueryResultSlice, bucket: CalendarBucket): UsageDayModel | null {
  const lanes = slice.howYouWork?.intervals?.lanes;
  if (!lanes) return null;
  const hourOf = (ms: number) => Math.max(0, Math.min(24, (ms - bucket.startMs) / HOUR_MS));
  const byAgent = new Map<string, { spans: { fromHour: number; toHour: number; waits: [number, number][] }[] }>();
  const working: { agentId: string; from: number; to: number; waits: readonly (readonly [number, number])[] }[] = [];
  for (const lane of lanes) {
    if (!lane.agentId) continue;
    for (const span of lane.busy) {
      if (span.endMs <= bucket.startMs || span.startMs >= bucket.endMs) continue;
      const waits = lane.waits.filter((wait) => wait.endMs > span.startMs && wait.startMs < span.endMs)
        .map((wait) => [hourOf(Math.max(wait.startMs, span.startMs)), hourOf(Math.min(wait.endMs, span.endMs))] as [number, number]);
      const entry = byAgent.get(lane.agentId) ?? { spans: [] };
      entry.spans.push({ fromHour: hourOf(span.startMs), toHour: hourOf(span.endMs), waits });
      byAgent.set(lane.agentId, entry);
      working.push({ agentId: lane.agentId, from: hourOf(span.startMs), to: hourOf(span.endMs), waits });
    }
  }
  // Display bins sample the witnessed spans at each bin's middle; the peak figure is the owner's own.
  const atOnce = Array.from({ length: DAY_BINS }, (_, bin) => {
    const at = ((bin + 0.5) / DAY_BINS) * 24;
    return working.filter((span) => at >= span.from && at < span.to && !span.waits.some(([from, to]) => at >= from && at < to)).length;
  });
  const peakCount = bucket.totals.peakParallel ?? Math.max(0, ...atOnce);
  const peakBin = atOnce.reduce((best, count, index) => count > atOnce[best]! ? index : best, 0);
  const at = ((peakBin + 0.5) / DAY_BINS) * 24;
  const peakBy = new Map<string, number>();
  for (const span of working) if (at >= span.from && at < span.to && !span.waits.some(([from, to]) => at >= from && at < to)) peakBy.set(span.agentId, (peakBy.get(span.agentId) ?? 0) + 1);
  const agentTime = new Map(bucket.agents.flatMap((entry) => entry.agentId ? [[entry.agentId, entry.metrics.busyMs ?? 0] as const] : []));
  return {
    date: bucket.date,
    lanes: [...byAgent.entries()].map(([agentId, entry]) => ({ agentId, spans: entry.spans, agentTimeMs: agentTime.get(agentId) ?? 0 }))
      .sort((a, b) => b.agentTimeMs - a.agentTimeMs),
    atOnce,
    peak: { count: peakCount, atHour: (peakBin / DAY_BINS) * 24, byAgent: [...peakBy.entries()].map(([agentId, count]) => ({ agentId, count })).sort((a, b) => b.count - a.count) },
    waitCount: [...byAgent.values()].reduce((sum, entry) => sum + entry.spans.reduce((inner, span) => inner + span.waits.length, 0), 0),
  };
}

/** The week shown: the one containing `day`, else the period's busiest week by witnessed busy time. */
export function projectUsageScoreModel(calendar: UsageAgentCalendar, day: string | undefined): UsageScoreModel | null {
  const week = day ? calendar.weeks.find((bucket) => bucket.startMs <= Date.parse(`${day}T12:00:00Z`) && bucket.endMs > Date.parse(`${day}T12:00:00Z`))
    : calendar.weeks.reduce<UsageAgentCalendar['weeks'][number] | null>((best, bucket) => (bucket.totals.busyMs ?? 0) > (best?.totals.busyMs ?? 0) ? bucket : best, null);
  if (!week) return null;
  const rows = new Map<string, number[][]>();
  for (const bucket of calendar.hours) {
    if (bucket.hour === null || bucket.startMs < week.startMs || bucket.startMs >= week.endMs) continue;
    const dayIndex = Math.floor((bucket.startMs - week.startMs) / DAY_MS);
    for (const entry of bucket.agents) {
      if (!entry.agentId || !entry.metrics.busyMs) continue;
      const hours = rows.get(entry.agentId) ?? Array.from({ length: 7 }, () => Array.from<number>({ length: 24 }).fill(0));
      hours[dayIndex]![bucket.hour] = Math.min(60, Math.round(entry.metrics.busyMs / 60_000));
      rows.set(entry.agentId, hours);
    }
  }
  if (rows.size === 0) return null;
  const total = (hours: number[][]) => hours.flat().reduce((sum, value) => sum + value, 0);
  return { weekStart: week.date, encoding: 'minutes',
    rows: [...rows.entries()].sort((a, b) => total(b[1]) - total(a[1])).map(([agentId, hours]) => ({ agentId, hours })) };
}

/** Named Agents consume the owner's full-period accounting shares, including Unknown in its denominator. */
export function projectUsageAgentShares(calendar: UsageAgentCalendar, metric: UsageChartMetric): readonly UsageAgentShare[] {
  const days = new Map(calendar.agentActiveDays.map((entry) => [entry.agentId, entry.days]));
  return calendar.periodSummary.agents.flatMap((entry) => entry.agentId === null ? [] : [{
    agentId: entry.agentId,
    share: metric === 'tokens' || metric === 'cost' ? entry.shares[metric] : null,
    activeDays: days.get(entry.agentId) ?? null,
  }])
    .sort((a, b) => (b.share ?? -1) - (a.share ?? -1));
}

export function projectUsageRiverModel(calendar: UsageAgentCalendar, metric: UsageChartMetric): UsageRiverModel | null {
  const totals = new Map(calendar.weeks.map((week) => [week.startMs, readUsageCalendarMetric(week.totals, metric) ?? 0]));
  const weeks = calendar.weeklyAgentMix.filter((week) => week.endMs <= calendar.period.endMs).map((week) => ({
    start: resolveUsageCalendarInstant(week.startMs, calendar.timeZoneOffsetMinutes).date, total: totals.get(week.startMs) ?? 0,
    shares: Object.fromEntries(week.mix.flatMap((entry) => entry.agentId ? [[entry.agentId, entry.share]] : [])),
  }));
  return weeks.length >= 2 ? { width: 'amount', weeks } : null;
}

export function projectUsageShippedModel(slice: UsageQueryResultSlice): UsageShippedModel | null {
  const merged = slice.mergedOutcomes;
  if (!merged) return null;
  const weeks = merged.mergeWeeks.map((week) => ({ start: resolveUsageCalendarInstant(week.bucketStartMs, merged.timeZoneOffsetMinutes).date,
    spines: merged.outcomes.filter((outcome) => outcome.mergedAtMs !== null && outcome.mergedAtMs >= week.bucketStartMs && outcome.mergedAtMs < week.bucketEndMs)
      .map((outcome) => outcome.attribution === 'single' && outcome.leadingAgentIds[0] ? outcome.leadingAgentIds[0] : 'mixed' as const) }));
  return { mode: 'weeks', weeks, undated: merged.undatedMergedCount, total: merged.mergedInPeriodCount + merged.undatedMergedCount };
}

const COLLABORATION_KIND = { spawn: 'session', run: 'run', review: 'run', plan: 'run', native: 'native' } as const;
export function projectUsageConstellationModel(slice: UsageQueryResultSlice, shares: readonly UsageAgentShare[]): UsageConstellationModel {
  const summary = slice.howYouWork?.collaboration ?? null;
  const edges = new Map<string, { from: string; to: string; kind: 'session' | 'run' | 'native'; count: number }>();
  // Reporting, replay and handoff are not collaboration between two Agents (moved or reported work); they are not drawn as edges.
  for (const edge of summary?.edges ?? []) {
    const kind = (COLLABORATION_KIND as Record<string, 'session' | 'run' | 'native' | undefined>)[edge.relation];
    if (!kind || !edge.sourceAgentId || !edge.targetAgentId) continue;
    const key = `${edge.sourceAgentId}\u0000${edge.targetAgentId}\u0000${kind}`;
    const entry = edges.get(key) ?? { from: edge.sourceAgentId, to: edge.targetAgentId, kind, count: 0 };
    entry.count += edge.count;
    edges.set(key, entry);
  }
  const ids = new Set(shares.map((share) => share.agentId));
  for (const edge of edges.values()) { ids.add(edge.from); ids.add(edge.to); }
  return { nodes: [...ids].map((agentId) => ({ agentId, share: shares.find((share) => share.agentId === agentId)?.share ?? null })),
    edges: summary ? [...edges.values()] : null, unknownStarts: summary?.unknownSourceAgentCount ?? 0 };
}

export function projectUsageSteeringModel(slice: UsageQueryResultSlice): UsageSteeringTideModel | null {
  const steering = slice.howYouWork?.steering;
  if (!steering) return null;
  const night = slice.howYouWork?.nightShift ?? null;
  return { night: night ? { fromHour: night.startHour, toHour: night.endHour } : null,
    rows: steering.byAgent.filter((row) => row.agentId !== null || (row.steeringCount ?? 0) + (row.permissionAnswerCount ?? 0) > 0).map((row) => {
      const hourly = steering.hourly.filter((entry) => entry.agentId === row.agentId);
      const steersByHour = Array.from<number>({ length: 24 }).fill(0), phoneAnswersByHour = Array.from<number>({ length: 24 }).fill(0);
      for (const entry of hourly) {
        steersByHour[entry.hour] = steersByHour[entry.hour]! + (entry.steeringCount ?? 0);
        phoneAnswersByHour[entry.hour] = phoneAnswersByHour[entry.hour]! + entry.byAnsweringClient.ios + entry.byAnsweringClient.android;
      }
      return { agentId: row.agentId, steersByHour, phoneAnswersByHour, steers: row.steeringCount, busyMs: row.busyMs, perBusyHour: row.steersPerBusyHour,
        phoneAnswers: row.byAnsweringClient.ios + row.byAnsweringClient.android };
    }) };
}

export function projectUsageRunLengthModel(slice: UsageQueryResultSlice): UsageRunLengthModel | null {
  const runs = slice.howYouWork?.runLengths;
  if (!runs || runs.sampleCount === 0) return null;
  return { rows: runs.byAgent.filter((row) => row.sampleCount > 0).map((row) => ({ agentId: row.agentId, samples: row.sampleCount, medianMs: row.medianMs,
    p90Ms: row.p90Ms, durationsMs: row.durationsMs })), openCount: runs.openCount, croppedCount: runs.croppedCount };
}

export type UsageRecordFacts = Readonly<{
  longestStreak: Readonly<{ days: number; startDate: string; endDate: string; ongoing: boolean }> | null;
  busiestDay: Readonly<{ date: string; value: number }> | null;
  peakParallel: Readonly<{ date: string; count: number }> | null;
  longestClosedTurn: Readonly<{ agentId: string | null; ms: number }> | null;
  mostAgents: Readonly<{ date: string; count: number }> | null;
}>;

/** In-period observed bests, each read from its owner; a record without an owner fact is omitted, never estimated. */
export function projectUsageRecordFacts(slice: UsageQueryResultSlice, metric: UsageChartMetric, referenceMs: number): UsageRecordFacts | null {
  const calendar = slice.howYouWork?.agentCalendar;
  if (!calendar) return null;
  const sky = projectUsageSkyModel(calendar, metric, 'intensity', referenceMs);
  let busiest: { date: string; value: number } | null = null;
  let peak: { date: string; count: number } | null = null;
  let most: { date: string; count: number } | null = null;
  for (const bucket of calendar.days) {
    const value = readUsageCalendarMetric(bucket.totals, metric);
    if (value !== null && value > (busiest?.value ?? 0)) busiest = { date: bucket.date, value };
    if ((bucket.totals.peakParallel ?? 0) > (peak?.count ?? 0)) peak = { date: bucket.date, count: bucket.totals.peakParallel! };
    const agents = bucket.agents.filter((entry) => entry.agentId !== null && ((entry.metrics.eventCount ?? 0) > 0 || (entry.metrics.busyMs ?? 0) > 0)).length;
    if (agents > (most?.count ?? 0)) most = { date: bucket.date, count: agents };
  }
  let longest: { agentId: string | null; ms: number } | null = null;
  for (const row of slice.howYouWork?.runLengths?.byAgent ?? []) for (const ms of row.durationsMs) if (ms > (longest?.ms ?? 0)) longest = { agentId: row.agentId, ms };
  return {
    longestStreak: sky.best ? { days: sky.best.days, startDate: sky.best.startDate, endDate: sky.best.endDate,
      ongoing: sky.current !== null && sky.current !== undefined && sky.current.startDate === sky.best.startDate } : null,
    busiestDay: busiest, peakParallel: peak, longestClosedTurn: longest, mostAgents: most,
  };
}
