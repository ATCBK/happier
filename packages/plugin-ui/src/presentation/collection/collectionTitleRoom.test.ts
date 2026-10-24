import { describe, expect, it } from 'vitest';

import { resolveHappierCollectionTitleAccessoryFits } from './collectionTitleRoom.js';

// The title row keeps its title readable: a view switch beside it yields before the title would shrink
// below its floor, and returns only once both fit again.
describe('resolveHappierCollectionTitleAccessoryFits', () => {
  const floor = 88;
  const gap = 2;

  it('keeps the control while the title still has its floor', () => {
    expect(resolveHappierCollectionTitleAccessoryFits({ shown: true, titleWidth: 96, accessoryWidth: 64, titleFloor: floor, gap })).toBe(true);
  });

  it('lets the control yield once the title would collapse (touch floor beside a canvas)', () => {
    expect(resolveHappierCollectionTitleAccessoryFits({ shown: true, titleWidth: 52, accessoryWidth: 92, titleFloor: floor, gap })).toBe(false);
  });

  it('brings the control back only when title floor and control both fit, so it never flickers', () => {
    // Without the control the title has 140: 140 - 92 - 2 = 46 < 88, so it stays out.
    expect(resolveHappierCollectionTitleAccessoryFits({ shown: false, titleWidth: 140, accessoryWidth: 92, titleFloor: floor, gap })).toBe(false);
    expect(resolveHappierCollectionTitleAccessoryFits({ shown: false, titleWidth: 190, accessoryWidth: 92, titleFloor: floor, gap })).toBe(true);
  });

  it('shows the control before anything is measured', () => {
    expect(resolveHappierCollectionTitleAccessoryFits({ shown: true, titleWidth: null, accessoryWidth: null, titleFloor: floor, gap })).toBe(true);
  });
});
