/**
 * Local wall-clock date/time text, and the exact instant it names.
 *
 * Everything here is deliberately local-time: the author picks the moment they
 * mean where they are, and the only way to keep that promise across a daylight
 * saving change is to let the platform resolve `new Date(y, m, d, h, min)`
 * rather than doing arithmetic on an offset that is about to change. The result
 * is an absolute epoch instant, so nothing downstream has to re-interpret it.
 */

export type HappierLocalDateTimeDraft = Readonly<{
  /** `YYYY-MM-DD` in the author's own calendar. */
  date: string;
  /** `HH:mm` on the author's own clock. */
  time: string;
}>;

export function formatHappierLocalDateInput(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatHappierLocalTimeInput(value: Date): string {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

export function toHappierLocalDateTimeDraft(value: Date): HappierLocalDateTimeDraft {
  return { date: formatHappierLocalDateInput(value), time: formatHappierLocalTimeInput(value) };
}

/**
 * The epoch instant for one local wall-clock reading, or `null` when the text is
 * not a real local moment.
 *
 * The round-trip check is what rejects both `2026-02-31` and the hour that does
 * not exist on a spring-forward day: the platform silently normalizes those, and
 * a silently shifted instant is worse than a refused one.
 */
export function parseHappierLocalDateTime(draft: HappierLocalDateTimeDraft): number | null {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(draft.date.trim());
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(draft.time.trim());
  if (!dateMatch || !timeMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = Number(timeMatch[1]);
  const minute = Number(timeMatch[2]);
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (
    value.getFullYear() !== year
    || value.getMonth() !== month - 1
    || value.getDate() !== day
    || value.getHours() !== hour
    || value.getMinutes() !== minute
  ) return null;
  return value.getTime();
}

/** The instant this reading names, but only when it is a real future moment. */
export function resolveHappierFutureLocalDateTime(value: HappierLocalDateTimeDraft, nowMs: number): number | null {
  const parsed = parseHappierLocalDateTime(value);
  return parsed !== null && parsed > nowMs ? parsed : null;
}
