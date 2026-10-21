import { resolveUsageCalendarInstant, summarizeUsageRunLengthObservations, type PublicProfileSnapshotV1 } from '@happier-dev/plugin-sdk';
import type { UsageAgentShare, UsageConstellationModel, UsageRiverModel, UsageShippedModel } from './UsageAgentsCharts.js';
import type { UsageDaylightModel, UsageWeekHourModel } from './UsageRhythmEncodings.js';
import type { UsageSkyModel } from './UsageSkyOfDays.js';
import type { UsagePortraitModel, UsageRecordsModel, UsageRunLengthModel } from './UsageWorkCharts.js';

export type PublicUsageRecordKind = 'activeDays' | 'currentStreakDays' | 'bestStreakDays' | 'peakParallel' | 'longestTurnMs';

/** Host-localized record lines for the same Personal-records body, with no private dates or chronology. */
export function projectPublicUsageRecords(snapshot: PublicProfileSnapshotV1,
  format: (kind: PublicUsageRecordKind, value: number) => Omit<UsageRecordsModel[number], 'id'>): UsageRecordsModel {
  const { facts } = snapshot;
  const rows: UsageRecordsModel[number][] = [];
  for (const kind of ['activeDays', 'currentStreakDays', 'bestStreakDays', 'peakParallel'] as const) {
    const value = facts[kind];
    if (value !== undefined) rows.push({ id: kind, ...format(kind, value) });
  }
  if (facts.sessionDurations !== undefined) {
    const summary = summarizeUsageRunLengthObservations(facts.sessionDurations);
    if (summary.sampleCount > 0) {
      const longest = summary.byAgent.reduce((max, row) => Math.max(max, row.durationsMs[row.durationsMs.length - 1]!), 0);
      rows.push({ id: 'longestTurnMs', ...format('longestTurnMs', longest) });
    }
  }
  return rows;
}

export type PublicUsageChartModels = Readonly<{
  sky: UsageSkyModel | null;
  weekHours: UsageWeekHourModel | null;
  daylight: UsageDaylightModel | null;
  agentShares: readonly UsageAgentShare[] | null;
  river: UsageRiverModel | null;
  shipped: UsageShippedModel | null;
  constellation: UsageConstellationModel | null;
  portrait: UsagePortraitModel;
  runLength: UsageRunLengthModel | null;
  /** Only the approved aggregate. There is no public day, lane, clock or peak attribution. */
  peak: number | null;
}>;

/**
 * Adapts the already policy-projected snapshot, never private query results. This is not a mask:
 * the publication owner must project before calling it. Optional facts remain independent, including
 * geometry denominators. Public ordinal levels are never converted back into amounts or leaders.
 */
export function projectPublicUsageChartModels(snapshot: PublicProfileSnapshotV1): PublicUsageChartModels {
  const { facts, period } = snapshot;
  const sky: UsageSkyModel | null = facts.calendar === undefined ? null : {
    encoding: 'ordinal', colourBy: 'intensity',
    days: facts.calendar.map(day => day.level === null ? { date: day.date, state: 'unknown' }
      : day.level === 0 ? { date: day.date, state: 'inactive' }
        : { date: day.date, state: 'active', level: day.level }),
    // The approved counts carry no private run positions. The body must not invent them.
    ...(facts.currentStreakDays === undefined ? {} : { current: { days: facts.currentStreakDays } }),
    ...(facts.bestStreakDays === undefined ? {} : { best: { days: facts.bestStreakDays } }),
  };
  const activeDays = new Map(facts.agentActiveDays?.map(row => [row.agentId, row.days]));
  const mixes = new Map(facts.agentMix?.map(row => [row.agentId, row]));
  const memberIds = new Set([...mixes.keys(), ...activeDays.keys()]);
  const agentShares: readonly UsageAgentShare[] | null = facts.agentMix === undefined && facts.agentActiveDays === undefined ? null
    : [...memberIds].map(agentId => {
      const mix = mixes.get(agentId);
      return { agentId, share: mix === undefined || mix.coverage.method === 'context_only' ? null : mix.share,
        ...(activeDays.has(agentId) ? { activeDays: activeDays.get(agentId)! } : {}) };
    });
  const grid = Array.from({ length: 7 }, () => Array.from<number | null>({ length: 24 }).fill(null));
  for (const cell of facts.punch ?? []) grid[(cell.weekday + 6) % 7]![cell.hour] = cell.level;
  // An ordinal maximum, not a sum or an amount: the strongest shared weekday cell at each hour.
  const hours = Array.from<number | null>({ length: 24 }).fill(null);
  for (const cell of facts.punch ?? []) if (cell.level !== null) hours[cell.hour] = Math.max(hours[cell.hour] ?? 0, cell.level);
  const night = facts.dayNightActivity;
  const distribution = facts.sessionDurations === undefined ? null : summarizeUsageRunLengthObservations(facts.sessionDurations);
  const firstDay = resolveUsageCalendarInstant(period.startMs, period.timeZoneOffsetMinutes);
  const lastDay = resolveUsageCalendarInstant(period.endMs - 1, period.timeZoneOffsetMinutes);
  return {
    sky,
    weekHours: facts.punch === undefined ? null : { encoding: 'ordinal', grid },
    daylight: facts.punch === undefined && !night ? null : { encoding: 'ordinal', hours,
      night: night ? { fromHour: night.window.startHour, toHour: night.window.endHour, share: night.nightShare } : null },
    agentShares,
    // Equal width explicitly means composition only. Tokens and calendar cannot become a hidden width channel.
    river: facts.weeklyAgentMix === undefined ? null : { width: 'share', weeks: facts.weeklyAgentMix.map(week => ({
      start: resolveUsageCalendarInstant(week.startMs, period.timeZoneOffsetMinutes).date, total: null,
      shares: Object.fromEntries(week.mix.filter(row => row.coverage.method !== 'context_only').map(row => [row.agentId, row.share])),
    })) },
    shipped: facts.mergedPrs === undefined ? null : { mode: 'count', total: facts.mergedPrs },
    constellation: agentShares === null ? null : { nodes: agentShares, edges: null, unknownStarts: null },
    portrait: {
      ...(facts.activeDays === undefined ? {} : { activeDays: { active: facts.activeDays,
        of: 1 + Math.round((lastDay.bucketStartMs - firstDay.bucketStartMs) / 86_400_000) } }),
      ...(facts.peakParallel === undefined ? {} : { peakParallel: facts.peakParallel }),
      ...(facts.currentStreakDays === undefined ? {} : { streak: { current: facts.currentStreakDays, best: facts.bestStreakDays ?? null } }),
    },
    runLength: distribution === null ? null : { rows: distribution.byAgent.map(row => ({ agentId: row.agentId,
      samples: row.sampleCount, medianMs: row.medianMs, p90Ms: row.p90Ms, durationsMs: row.durationsMs })), openCount: null, croppedCount: null },
    peak: facts.peakParallel ?? null,
  };
}
