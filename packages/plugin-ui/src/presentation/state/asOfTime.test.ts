import { describe, expect, it } from 'vitest';

import { formatHappierAsOfTime, resolveHappierFreshnessText } from './asOfTime.js';

describe('resolveHappierFreshnessText: one text policy for host and plugin freshness lines', () => {
  const formatAsOf = (time: string) => `As of ${time}`;
  const now = new Date(2026, 8, 29, 11, 0).getTime();
  const asOf = new Date(2026, 8, 29, 10, 42).getTime();

  it('tells the time in the viewer\'s own locale clock, the way every other time on the page does', () => {
    const afternoon = new Date(2026, 8, 29, 15, 30).getTime();
    expect(formatHappierAsOfTime(afternoon, now, 'en-US')).toBe('03:30 PM');
    expect(formatHappierAsOfTime(afternoon, now, 'de')).toBe('15:30');
    expect(formatHappierAsOfTime(afternoon, new Date(2026, 8, 30).getTime(), 'en-US')).toBe('Sep 29, 03:30 PM');
  });

  it('says when the retained content was read, then why it may be behind', () => {
    expect(resolveHappierFreshnessText({ asOf, now, reason: 'devbox isn’t answering', formatAsOf }))
      .toMatch(/^As of 10:42.* · devbox isn’t answering$/u);
  });

  it('keeps the read time while a reconnect is in flight, and says the reason alone without one', () => {
    expect(resolveHappierFreshnessText({ asOf, now, reason: 'Reconnecting…', formatAsOf }))
      .toMatch(/^As of 10:42.* · Reconnecting…$/u);
    expect(resolveHappierFreshnessText({ asOf: null, reason: 'Reconnecting…', formatAsOf })).toBe('Reconnecting…');
  });
});
