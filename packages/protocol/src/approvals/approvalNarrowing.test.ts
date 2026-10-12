import { describe, expect, it } from 'vitest';

import { subsetNarrowing } from './approvalNarrowing.js';

const first = { ref: 'a', expect: { identity: 'a1' }, reason: 'Unused build', claimedVerdict: 'caution' };
const second = { ref: 'b', expect: { identity: 'b1' }, reason: 'Old cache', claimedVerdict: 'keep' };
const original = { machineId: 'machine', items: [first, second], emptyAfter: true, goalBytes: 500 };

describe('approval subset narrowing', () => {
  const narrowing = subsetNarrowing({ path: 'items', key: item => String(item.ref), refreshable: ['expect'], reducible: ['emptyAfter'] });

  it('admits a nonempty subset with refreshed expectations and a dropped permanent flag', () => {
    const chosen = { ...original, items: [{ ...second, expect: { identity: 'b2' } }], emptyAfter: false };
    expect(narrowing.narrow(original, chosen)).toEqual(chosen);
    const { emptyAfter: _emptyAfter, ...withoutFlag } = chosen;
    expect(narrowing.narrow(original, withoutFlag)).toEqual(withoutFlag);
    // Verdicts are display claims, never an approval decision.
    expect(narrowing.narrow(original, original)).toEqual(original);
  });

  it.each([
    { ...original, items: [] },
    { ...original, items: [first, { ...second, ref: 'new' }] },
    { ...original, items: [first, first] },
    { ...original, items: [{ ...first, reason: 'Changed reason' }] },
    { ...original, items: [{ ...first, claimedVerdict: 'safe' }] },
    { ...original, items: [first], machineId: 'other' },
    { ...original, items: [first], goalBytes: 999 },
  ])('refuses additions, empty/duplicate selections, and changes outside refreshable fields', chosen => {
    expect(narrowing.narrow(original, chosen)).toBeNull();
  });

  it('never adds a permanent effect or accepts an ambiguous admitted set', () => {
    expect(narrowing.narrow({ ...original, emptyAfter: false }, original)).toBeNull();
    expect(narrowing.narrow({ ...original, items: [first, first] }, { ...original, items: [first] })).toBeNull();
    expect(narrowing.narrow(null, original)).toBeNull();
  });
});
