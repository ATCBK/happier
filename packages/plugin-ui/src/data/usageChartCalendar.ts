import { resolveUsageCalendarInstant } from '@happier-dev/plugin-sdk';

const DAY_MS = 86_400_000;
type Period = Readonly<{ startMs: number; endMs: number }>;

/** Calendar dates intersecting the admitted half-open period, including both clipped edge dates. */
export function countUsageChartCalendarDates(period: Period, offsetMinutes: number): number {
  const first = resolveUsageCalendarInstant(period.startMs, offsetMinutes);
  const last = resolveUsageCalendarInstant(period.endMs - 1, offsetMinutes);
  return 1 + Math.round((last.bucketStartMs - first.bucketStartMs) / DAY_MS);
}

/** Labels the canonical owner's clipped week; never expands its population to a full week. */
export function projectUsageRiverWeekRange(period: Period, offsetMinutes: number) {
  const first = resolveUsageCalendarInstant(period.startMs, offsetMinutes);
  return { start: first.date, end: resolveUsageCalendarInstant(period.endMs - 1, offsetMinutes).date,
    partial: first.weekday !== 1 || period.startMs !== first.bucketStartMs || period.endMs - period.startMs !== 7 * DAY_MS };
}
