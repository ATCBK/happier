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

/** Selected monetary state, after population-level overlap has been resolved.
 * Available with no selection is the empty/covered identity; unavailable is sticky.
 */
export interface UsageSelectedCostAccumulator {
    available: boolean;
    selected: UsageSelectedCostBasis | null;
}

export function createEmptyUsageSelectedCost(): UsageSelectedCostAccumulator {
    return { available: true, selected: null };
}

export function selectResolvedUsageCost(cost: UsageObservationCost, mode: UsageCostMode): UsageSelectedCostAccumulator {
    if ((cost as AggregatedUsageCost)[usageCostAggregationBasis]?.covered) return createEmptyUsageSelectedCost();
    const selected = resolveUsageCostBasis(cost, mode);
    return { available: selected !== null, selected };
}

/** Merge already-selected partitions without re-reading raw facts or resolving overlap. */
export function mergeUsageSelectedCosts(left: UsageSelectedCostAccumulator, right: UsageSelectedCostAccumulator,
    mode: UsageCostMode): UsageSelectedCostAccumulator {
    if (!left.available || !right.available) return { available: false, selected: null };
    if (!left.selected) return right;
    if (!right.selected) return left;
    const a = left.selected;
    const b = right.selected;
    if (a.currency !== b.currency || mode !== 'auto' && a.kind !== b.kind) return { available: false, selected: null };
    return { available: true, selected: { kind: a.kind === b.kind ? a.kind : 'mixed', currency: a.currency,
        amountUsd: a.amountUsd + b.amountUsd,
        source: a.kind === b.kind && a.source === b.source ? a.source : 'best_available' } };
}

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
    const rightCovered = (right as AggregatedUsageCost)[usageCostAggregationBasis]?.covered === true;
    const merged = mergeUsageSelectedCosts({ available: leftEmpty || leftBasis !== null, selected: leftBasis },
        { available: rightCovered || rightBasis !== null, selected: rightCovered ? null : rightBasis }, mode);
    return { ...combined,
        ...(leftEmpty && rightBasis && !rightCovered ? { currency: right.currency,
            costSource: noApiPopulation ? right.costSource : combined.costSource } : {}),
        ...(!merged.available ? { costSource: 'none' as const } : {}),
        ...(merged.selected ? { effectiveUsd: merged.selected.amountUsd } : {}),
        [usageCostAggregationBasis]: { mode, available: merged.available, ...(merged.selected ? { selected: merged.selected } : {}) } };
}

export function withEffectiveUsageCost(cost: UsageObservationCost, mode: UsageCostMode): UsageObservationCost {
    const basis = resolveUsageCostBasis(cost, mode);
    const { effectiveUsd: _previous, ...raw } = cost;
    return basis ? { ...raw, effectiveUsd: basis.amountUsd } : raw;
}
