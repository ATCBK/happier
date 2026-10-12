import { expect, it } from 'vitest';
import { addUsageCostForMode, withEffectiveUsageCost } from './usageAggregation.js';
import { resolveUsageCostBasis } from './usageCost.js';

it('labels best available mixed reported and current-tariff money without changing explicit tariff totals', () => {
    const reported = { reportedUsd: 1, estimatedUsd: 0, currency: 'USD', costSource: 'provider_reported' as const,
        apiEquivalentUsd: 2, pricingSource: 'litellm:test' };
    const equivalent = { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' as const,
        apiEquivalentUsd: 3, pricingSource: 'litellm:test' };
    const combined = addUsageCostForMode(reported, equivalent, 'auto');
    expect(resolveUsageCostBasis(combined, 'auto')).toMatchObject({ kind: 'mixed', amountUsd: 4, currency: 'USD' });
    expect(withEffectiveUsageCost(combined, 'auto').effectiveUsd).toBe(4);
    const repeated = addUsageCostForMode(combined, reported, 'auto');
    expect(resolveUsageCostBasis(repeated, 'auto')).toMatchObject({ kind: 'mixed', amountUsd: 5, currency: 'USD' });
    expect(resolveUsageCostBasis(combined, 'api_equivalent')).toMatchObject({ amountUsd: 5 });
});
