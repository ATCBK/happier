import type { UsageObservationCost, UsageObservationTokens } from './usageAnalyticsContracts.js';
import { resolveUsageCostBasis, type UsageCostMode, type UsageSelectedCostBasis } from './usageCostFacts.js';

export function createEmptyUsageTokens(): UsageObservationTokens {
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function createEmptyUsageCost(currency = 'USD'): UsageObservationCost {
    return { reportedUsd: 0, estimatedUsd: 0, invoiceUsd: 0, billingContext: 'unknown', costSource: 'none', currency };
}

export function addUsageTokens(left: UsageObservationTokens, right: UsageObservationTokens): UsageObservationTokens {
    return { input: left.input + right.input, output: left.output + right.output, reasoning: left.reasoning + right.reasoning,
        cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite, total: left.total + right.total };
}

export function addUsageCost(left: UsageObservationCost, right: UsageObservationCost): UsageObservationCost {
    const keys = new Set([...Object.keys(left.breakdown ?? {}), ...Object.keys(right.breakdown ?? {})]);
    const breakdown = keys.size ? Object.fromEntries([...keys].map(key => [key, (left.breakdown?.[key] ?? 0) + (right.breakdown?.[key] ?? 0)])) : undefined;
    return { reportedUsd: left.reportedUsd + right.reportedUsd, estimatedUsd: left.estimatedUsd + right.estimatedUsd,
        invoiceUsd: (left.invoiceUsd ?? 0) + (right.invoiceUsd ?? 0),
        billingContext: left.billingContext === right.billingContext ? left.billingContext : 'unknown',
        costSource: left.costSource === right.costSource ? left.costSource : 'none',
        currency: left.currency === right.currency ? left.currency : 'MIXED', breakdown };
}

// Distinguish the initial zero accumulator from an already unpriced population.
// This aggregation-only evidence never enters the serialized contract.
export const usageCostAggregationBasis = Symbol('usageCostAggregationBasis');
export type AggregatedUsageCost = UsageObservationCost & { [usageCostAggregationBasis]?: {
    mode: UsageCostMode; available: boolean; selected?: UsageSelectedCostBasis; covered?: boolean;
} };

/** Resolve whole-total overlap only within the actual selected population, including bucket/Work subsets. */
export function resolveUsageContributionCosts(rows: readonly { id?: string; cost: UsageObservationCost }[], mode: UsageCostMode): UsageObservationCost[] {
    if (mode === 'estimated') return rows.map(row => {
        // A scoped money-only report is not another estimated-token population.
        if (!row.cost.reportedTotalContributionIds || row.cost.estimatedUsd !== 0) return row.cost;
        const cost: AggregatedUsageCost = { ...row.cost, [usageCostAggregationBasis]: { mode, available: true, covered: true } };
        return cost;
    });
    if (mode !== 'auto' && mode !== 'reported') return rows.map(row => row.cost);
    const ids = new Set(rows.flatMap(row => row.id ? [row.id] : []));
    const completeTotals = new Map(rows.filter(row => row.id && row.cost.reportedTotalContributionIds
        && row.cost.reportedTotalContributionIds.every(id => ids.has(id)))
        .map(row => [row.id!, new Set(row.cost.reportedTotalContributionIds)]));
    return rows.map(row => {
        const total = row.cost.reportedTotalId && completeTotals.get(row.cost.reportedTotalId);
        if (total && row.id && total.has(row.id)) {
            const cost: AggregatedUsageCost = { ...row.cost, [usageCostAggregationBasis]: { mode, available: true, covered: true } };
            return cost;
        }
        if (row.id && completeTotals.has(row.id)) {
            const { reportedTotalContributionIds: _scope, ...raw } = row.cost;
            const selected = resolveUsageCostBasis(raw, mode);
            const cost: AggregatedUsageCost = { ...row.cost, [usageCostAggregationBasis]: { mode,
                available: selected !== null, ...(selected ? { selected } : {}) } };
            return cost;
        }
        return row.cost;
    });
}

export function aggregateUsageContributionCosts(rows: readonly { id?: string; cost: UsageObservationCost }[], mode: UsageCostMode): AggregatedUsageCost {
    return resolveUsageContributionCosts(rows, mode).reduce((total, cost) => addUsageCostForMode(total, cost, mode), createEmptyUsageCost());
}

export function addUsageCostForMode(left: UsageObservationCost, right: UsageObservationCost, mode: UsageCostMode): AggregatedUsageCost {
    const leftBasis = resolveUsageCostBasis(left, mode);
    const rightBasis = resolveUsageCostBasis(right, mode);
    const leftAggregate: AggregatedUsageCost = left;
    const state = leftAggregate[usageCostAggregationBasis];
    const leftEmpty = state ? state.available && !state.selected : left.apiEquivalentUsd === undefined && left.costSource === 'none'
        && left.reportedUsd === 0 && left.estimatedUsd === 0 && (left.invoiceUsd ?? 0) === 0;
    const noApiPopulation = left.apiEquivalentUsd === undefined && left.reportedUsd === 0 && left.estimatedUsd === 0 && (left.invoiceUsd ?? 0) === 0;
    const apiEquivalentUsd = !state && noApiPopulation ? right.apiEquivalentUsd
        : left.apiEquivalentUsd !== undefined && right.apiEquivalentUsd !== undefined ? left.apiEquivalentUsd + right.apiEquivalentUsd : undefined;
    const combined = { ...addUsageCost(left, right), ...(apiEquivalentUsd !== undefined ? {
        apiEquivalentUsd, pricingSource: leftEmpty ? right.pricingSource
            : left.pricingSource === right.pricingSource ? left.pricingSource : 'effective_model_prices',
    } : {}) };
    if ((right as AggregatedUsageCost)[usageCostAggregationBasis]?.covered) return { ...combined,
        ...(leftBasis ? { effectiveUsd: leftBasis.amountUsd } : {}),
        [usageCostAggregationBasis]: { mode, available: leftEmpty || leftBasis !== null,
            ...(leftBasis ? { selected: leftBasis } : {}) } };
    if (leftEmpty && rightBasis) return { ...combined, currency: right.currency,
        costSource: noApiPopulation ? right.costSource : combined.costSource,
        effectiveUsd: rightBasis.amountUsd, [usageCostAggregationBasis]: { mode, available: true, selected: rightBasis } };
    if (leftBasis && rightBasis && (mode === 'auto' || leftBasis.kind === rightBasis.kind) && leftBasis.currency === rightBasis.currency) {
        const selected: UsageSelectedCostBasis = { kind: leftBasis.kind === rightBasis.kind ? leftBasis.kind : 'mixed',
            currency: leftBasis.currency, amountUsd: leftBasis.amountUsd + rightBasis.amountUsd,
            source: leftBasis.kind === rightBasis.kind && leftBasis.source === rightBasis.source ? leftBasis.source : 'best_available' };
        return { ...combined, effectiveUsd: selected.amountUsd,
            [usageCostAggregationBasis]: { mode, available: true, selected } };
    }
    return { ...combined, costSource: 'none', [usageCostAggregationBasis]: { mode, available: false } };
}

export function withEffectiveUsageCost(cost: UsageObservationCost, mode: UsageCostMode): UsageObservationCost {
    const basis = resolveUsageCostBasis(cost, mode);
    const { effectiveUsd: _previous, ...raw } = cost;
    return basis ? { ...raw, effectiveUsd: basis.amountUsd } : raw;
}
