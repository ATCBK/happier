import { expect, it } from 'vitest';
import { usageComparison } from './usageComparisonPresentation';

it('keeps valid small bases, shows scale as a multiple, and omits unknown or empty bases', () => {
  expect(usageComparison(0.0092, 0.01)).toMatchObject({ value: '▼ 8%' });
  expect(usageComparison(2, 1)).toMatchObject({ value: '▲ 2×' });
  expect(usageComparison(22_804, 100)).toMatchObject({ value: '▲ 228×' });
  expect(usageComparison(0, 1)).toMatchObject({ value: '▼ 100%' });
  for (const [current, previous] of [[1, 0], [1, null], [null, 1], [Infinity, 1], [1, NaN]] as const)
    expect(usageComparison(current, previous)).toBeNull();
});
