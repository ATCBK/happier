import { describe, expect, it } from 'vitest';

import { isSustainedV1 } from './isSustainedV1.js';

const records = (minutes: readonly number[], high = true) => minutes.map((minute) => ({ t: minute * 60_000, high }));

describe('isSustainedV1', () => {
  it.each([
    { name: 'full elapsed window', rows: records([1, 2, 3, 4, 5]), now: 300_000, duration: 300_000, yes: true, since: 0 },
    { name: 'missing minute', rows: records([1, 2, 4, 5]), now: 300_000, duration: 300_000, yes: false, since: 180_000 },
    { name: 'sleep after last sample', rows: records([1, 2, 3, 4, 5]), now: 420_000, duration: 300_000, yes: false, since: null },
    { name: 'partial streak', rows: records([4, 5]), now: 300_000, duration: 300_000, yes: false, since: 180_000 },
    { name: 'future sample does not extend streak', rows: records([4, 5, 6]), now: 300_000, duration: 180_000, yes: false, since: 180_000 },
  ])('$name', ({ rows, now, duration, yes, since }) => {
    expect(isSustainedV1({ records: rows, holds: (row) => row.high, sustainMs: duration, now }))
      .toEqual({ sustained: yes, since });
  });

  it('uses the same coverage for a false recovery predicate and breaks at a true minute', () => {
    const rows = [{ t: 60_000, high: true }, ...records([2, 3, 4], false)];
    expect(isSustainedV1({ records: rows, holds: (row) => !row.high, sustainMs: 180_000, now: 240_000 }))
      .toEqual({ sustained: true, since: 60_000 });
  });
});
