/** Minute timestamps end their measured interval. Missing minutes break both firing and recovery. */
export function isSustainedV1<T extends Readonly<{ t: number }>>(input: Readonly<{
  records: readonly T[];
  holds: (record: T) => boolean;
  sustainMs: number;
  now: number;
}>): Readonly<{ sustained: boolean; since: number | null }> {
  const minuteMs = 60_000;
  const currentMinute = Math.floor(input.now / minuteMs) * minuteMs;
  let end: number | null = null;
  let since: number | null = null;
  for (let index = input.records.length - 1; index >= 0; index -= 1) {
    const record = input.records[index];
    if (record.t > currentMinute) continue;
    if (end === null) {
      if (record.t !== currentMinute || !input.holds(record)) break;
      end = record.t;
    } else if (since === null || record.t !== since || !input.holds(record)) {
      break;
    }
    since = record.t - minuteMs;
  }
  return { sustained: since !== null && end !== null && end - since >= input.sustainMs, since };
}
