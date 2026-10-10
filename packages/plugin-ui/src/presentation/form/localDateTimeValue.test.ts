import { describe, expect, it } from 'vitest';

import {
  formatHappierLocalDateInput,
  formatHappierLocalTimeInput,
  parseHappierLocalDateTime,
  toHappierLocalDateTimeDraft,
} from './localDateTimeValue.js';

// A fixed zone with real daylight saving transitions, so "local time" here means
// something a naive UTC or fixed-offset implementation would get wrong rather
// than something that happens to pass on whichever machine runs the suite.
// Assigning `process.env.TZ` resets Node's cached zone, and every reading below
// is taken after this line runs.
process.env.TZ = 'America/New_York';

describe('localDateTimeValue', () => {
  it('resolves an arbitrary future local reading to the exact instant that wall clock names', () => {
    // 09:00 in New York in July is 13:00 UTC, not 09:00 UTC and not the
    // winter offset: only asking the platform for the local moment gets this
    // right on both sides of a daylight saving change.
    expect(parseHappierLocalDateTime({ date: '2026-07-04', time: '09:00' }))
      .toBe(Date.UTC(2026, 6, 4, 13, 0));
    expect(parseHappierLocalDateTime({ date: '2026-01-04', time: '09:00' }))
      .toBe(Date.UTC(2026, 0, 4, 14, 0));
  });

  it('round-trips a chosen instant back to the same local reading', () => {
    const chosen = new Date(2027, 1, 14, 23, 45);
    const draft = toHappierLocalDateTimeDraft(chosen);
    expect(draft).toEqual({ date: '2027-02-14', time: '23:45' });
    expect(parseHappierLocalDateTime(draft)).toBe(chosen.getTime());
  });

  it('keeps the earlier instant when a local reading occurs twice on a fall-back day', () => {
    // 01:30 happens twice on 2026-11-01 in New York. Naming the first one is
    // the only answer that is never later than what the author meant.
    expect(parseHappierLocalDateTime({ date: '2026-11-01', time: '01:30' }))
      .toBe(Date.UTC(2026, 10, 1, 5, 30));
  });

  it('refuses a local reading that does not exist on a spring-forward day', () => {
    // 02:30 never happens on 2026-03-08 in New York. Silently shifting it to
    // 03:30 would hand back an instant the author never chose.
    expect(parseHappierLocalDateTime({ date: '2026-03-08', time: '02:30' })).toBeNull();
  });

  it('refuses a calendar date that does not exist rather than rolling it forward', () => {
    expect(parseHappierLocalDateTime({ date: '2026-02-31', time: '09:00' })).toBeNull();
    expect(parseHappierLocalDateTime({ date: '2026-13-01', time: '09:00' })).toBeNull();
    expect(parseHappierLocalDateTime({ date: '2026-06-01', time: '25:00' })).toBeNull();
    expect(parseHappierLocalDateTime({ date: 'tomorrow', time: '09:00' })).toBeNull();
  });

  it('formats local calendar and clock fields with stable padding', () => {
    const value = new Date(2026, 8, 5, 7, 3);
    expect(formatHappierLocalDateInput(value)).toBe('2026-09-05');
    expect(formatHappierLocalTimeInput(value)).toBe('07:03');
  });
});
