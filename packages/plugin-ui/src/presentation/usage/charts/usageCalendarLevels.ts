import type { UsageCalendarArtModel } from './publicUsageChartModels.js';

/** 0 = no activity, 1–4 = how busy, null = not recorded (unknown is not zero). */
export type UsageCalendarLevel = UsageCalendarArtModel['days'][number]['level'];
export type UsageCalendarRun = Readonly<{
  start: number;
  end: number;
  days: number;
}>;

/** Unbroken runs of active days (index ranges). An unrecorded day breaks a run: a run is only what was witnessed. */
export function usageActiveRuns(
  days: UsageCalendarArtModel['days'],
): readonly UsageCalendarRun[] {
  const runs: UsageCalendarRun[] = [];
  let start = -1;
  for (let index = 0; index <= days.length; index++) {
    const active = index < days.length && (days[index]!.level ?? 0) > 0;
    if (active && start < 0) start = index;
    if (!active && start >= 0) {
      runs.push({ start, end: index - 1, days: index - start });
      start = -1;
    }
  }
  return runs;
}

/**
 * The drawn runs the shared streak counts name. The calendar already shows where runs are; a count is placed only
 * when a drawn run has exactly that length (the current one ending on the last day or, with the owner's grace, the
 * day before; the best one the latest such run). Otherwise the count is said in words and nothing is highlighted.
 */
export function usageStreakRuns(model: UsageCalendarArtModel) {
  const runs = usageActiveRuns(model.days);
  const last = model.days.length - 1;
  const current =
    model.currentStreakDays === undefined
      ? null
      : (runs.find(
          (run) =>
            run.days === model.currentStreakDays &&
            (run.end === last ||
              (run.end === last - 1 && (model.days[last]?.level ?? 0) === 0)),
        ) ?? null);
  const best =
    model.bestStreakDays === undefined
      ? null
      : ([...runs].reverse().find((run) => run.days === model.bestStreakDays) ??
        null);
  return {
    runs,
    current,
    best,
    /** Counts the calendar cannot place, said in words. */
    unplacedCurrent:
      model.currentStreakDays !== undefined && current === null
        ? model.currentStreakDays
        : null,
    unplacedBest:
      model.bestStreakDays !== undefined && best === null
        ? model.bestStreakDays
        : null,
  };
}

const dateUtc = (date: string) =>
  Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );

/** Monday-first weekday index (0–6) of a calendar date. */
export function usageWeekdayOf(date: string): number {
  return (new Date(dateUtc(date)).getUTCDay() + 6) % 7;
}

/** Day indices grouped by Monday week, in order; a week clipped by the period is marked partial. */
export function usageCalendarWeeks(
  days: UsageCalendarArtModel['days'],
): readonly Readonly<{
  start: string;
  days: readonly number[];
  partial: boolean;
}>[] {
  const weeks: { start: string; days: number[]; partial: boolean }[] = [];
  days.forEach((day, index) => {
    const start = new Date(
      dateUtc(day.date) - usageWeekdayOf(day.date) * 86_400_000,
    )
      .toISOString()
      .slice(0, 10);
    const last = weeks[weeks.length - 1];
    if (last && last.start === start) last.days.push(index);
    else weeks.push({ start, days: [index], partial: false });
  });
  for (const week of weeks)
    week.partial =
      week.days.length < 7 ||
      week.days.some((index) => days[index]!.level === null);
  return weeks;
}
