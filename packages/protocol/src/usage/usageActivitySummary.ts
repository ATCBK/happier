import type { UsageAnalyticsCoverage } from './usageAnalyticsContracts.js';
import { resolveUsageBucketBounds, resolveUsageCalendarDateStart } from './usageCalendar.js';

const DAY_MS = 86_400_000;

export interface UsageDayStreakInput {
    days?: readonly { date: string; eventCount: number | null }[];
    referenceMs: number;
    timeZoneOffsetMinutes: number;
    range?: { startMs?: number; endMs?: number };
    coverage?: UsageAnalyticsCoverage['status'];
}

export interface UsageDayStreakSummary {
    activeDays: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
    coverage: UsageAnalyticsCoverage['status'];
}

/** Counts supplied calendar days with period-local coverage, never lifetime history or a guaranteed lower bound. */
export function resolveUsageDayStreaks(input: UsageDayStreakInput): UsageDayStreakSummary {
    if (!input.days) return { activeDays: null, currentStreakDays: null, longestStreakDays: null, coverage: 'unknown' };
    const todayStartMs = resolveUsageBucketBounds('day', input.referenceMs, input.timeZoneOffsetMinutes).bucketStartMs;
    const active = new Set<number>();
    let coverage = input.coverage ?? 'unknown';
    for (const day of input.days) {
        const startMs = resolveUsageCalendarDateStart(day.date, input.timeZoneOffsetMinutes);
        if (startMs > todayStartMs || input.range?.startMs !== undefined && startMs + DAY_MS <= input.range.startMs
            || input.range?.endMs !== undefined && startMs >= input.range.endMs) continue;
        if (day.eventCount === null) {
            if (coverage === 'complete') coverage = 'partial';
        } else if (day.eventCount > 0) active.add(startMs);
    }
    let run = 0;
    let longestStreakDays = 0;
    let previous: number | undefined;
    for (const startMs of [...active].sort((left, right) => left - right)) {
        run = previous !== undefined && startMs - previous === DAY_MS ? run + 1 : 1;
        longestStreakDays = Math.max(longestStreakDays, run);
        previous = startMs;
    }
    const currentStreakDays = previous === todayStartMs || previous === todayStartMs - DAY_MS ? run : 0;
    return { activeDays: active.size, currentStreakDays, longestStreakDays, coverage };
}
