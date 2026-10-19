import { describe, expect, it } from 'vitest';
import { fitUsageStatFigureSize, resolveUsageStatCardLayout, USAGE_STAT_CARD_TYPE, type UsageStatCardFit } from './usageStatCardStyles';

const calm: UsageStatCardFit = {
  hasLead: false, hasComparisons: false, hasHeadline: true, mixRowCount: 0, panel: false, wrapsLabels: false,
};

describe('link-preview card fit', () => {
  it('keeps the full headline while the selection is light', () => {
    expect(resolveUsageStatCardLayout('link-preview', 0, 0, calm).headline).toBe(USAGE_STAT_CARD_TYPE.headline['link-preview']);
  });

  it('steps the headline and legend down as the selection grows, further in the styles that squeeze their labels', () => {
    const everything: UsageStatCardFit = { ...calm, hasComparisons: true, mixRowCount: 6 };
    const plain = resolveUsageStatCardLayout('link-preview', 5, 2, everything);
    const squeezed = resolveUsageStatCardLayout('link-preview', 5, 2, { ...everything, panel: true, wrapsLabels: true });
    expect(plain.headline).toBeLessThan(USAGE_STAT_CARD_TYPE.headline['link-preview']);
    expect(squeezed.headline).toBeLessThan(plain.headline);
    expect(squeezed.mixRows).toBeLessThanOrEqual(plain.mixRows ?? 0);
  });
});

describe('stat cells stay on one line', () => {
  it('sets up to five link-preview facts in one row, never three and one', () => {
    expect(resolveUsageStatCardLayout('link-preview', 4, 0, calm).columns).toBe(4);
    expect(resolveUsageStatCardLayout('link-preview', 5, 0, calm).columns).toBe(5);
  });

  it('fits a figure to its cell instead of wrapping "112.1 / M"', () => {
    const fitted = fitUsageStatFigureSize('112.1M', 30, 60);
    expect(fitted).toBeLessThan(30);
    expect(fitted * 0.62 * '112.1M'.length).toBeLessThanOrEqual(60);
    // A figure that already fits keeps the grid's size.
    expect(fitUsageStatFigureSize('12', 30, 120)).toBe(30);
  });
});
