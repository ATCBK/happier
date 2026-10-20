import type { UsageAnalyticsContribution, UsageAnalyticsCostFactKind, UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageObservationCost } from './usageAnalyticsContracts.js';
import { reprojectUsageLeaders } from './usageLeaderProjection.js';
import { aggregateUsageContributionCosts, resolveUsageContributionCosts, usageCostAggregationBasis, type AggregatedUsageCost } from './usageAggregation.js';
import { canonicalUsageModelPriceId } from './usageModelPriceSchemas.js';
import type { UsageModelPriceCatalog, UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';

export type UsageCostMode = NonNullable<UsageAnalyticsQueryRequest['costMode']> | 'auto';
export interface UsageCostBasis {
  kind: Exclude<UsageAnalyticsCostFactKind, 'unpriced'>;
  currency: string;
  amountUsd: number;
  source: string;
}
/** A best-available aggregate labels unlike witnessed kinds rather than calling them reported. */
export type UsageSelectedCostBasis = Omit<UsageCostBasis, 'kind'> & Readonly<{ kind: UsageCostBasis['kind'] | 'mixed' }>;

/** Covered fallback facts remain readable, but are not another selected charge or attributed zero. */
export function isUsageCostCoveredByReportedTotal(cost: UsageObservationCost, mode: UsageCostMode): boolean {
  return cost.reportedTotalId !== undefined && (mode === 'auto' || mode === 'reported');
}

export function resolveUsageCostMode(mode: UsageAnalyticsQueryRequest['costMode']): UsageCostMode {
  return mode ?? 'auto';
}

export function resolveUsageCostFactForMode<Fact extends { kind: UsageAnalyticsCostFactKind }>(facts: readonly Fact[], mode: UsageCostMode): Fact | undefined {
  if (mode === 'api_equivalent') return facts.find((fact) => fact.kind === 'api_equivalent');
  if (mode === 'reported') return facts.find((fact) => fact.kind === 'reported');
  if (mode === 'estimated') return facts.find((fact) => fact.kind === 'estimated');
  return facts.find((fact) => fact.kind === 'reported')
    ?? facts.find((fact) => fact.kind === 'api_equivalent')
    ?? facts.find((fact) => fact.kind === 'estimated')
    ?? facts.find((fact) => fact.kind === 'invoice');
}

/** Currency stays fixed; best available resolves witnessed kinds independently within each row. */
export type UsagePageCostSelection = Readonly<Pick<UsageSelectedCostBasis, 'kind' | 'currency'> & { mode?: UsageCostMode }>;
export type UsagePageCostProjection = Readonly<{
  selection: UsagePageCostSelection | null;
  amountUsd: number | null;
  accounting: UsageAnalyticsQueryResponse;
}>;

// In-process provenance of a completed projection, not serialized money or a
// second cache. A copied response with a different population must recompute.
export const usagePageCostProjectionBasis = Symbol('usagePageCostProjectionBasis');
export type UsagePageCostProjectionBasis = {
  readonly response: UsageAnalyticsQueryResponse;
  readonly mode: UsageCostMode;
  readonly catalog: UsageModelPriceCatalog;
  readonly overrides: UsageModelPriceOverridesV1;
  pageInput?: UsageAnalyticsQueryResponse;
  pageProjection?: UsagePageCostProjection;
};

export function readUsagePageCostProjectionBasis(response: UsageAnalyticsQueryResponse): UsagePageCostProjectionBasis | undefined {
  const completed = (response.totals.cost as UsageObservationCost & {
    [usagePageCostProjectionBasis]?: UsagePageCostProjectionBasis;
  })[usagePageCostProjectionBasis];
  if (!completed) return undefined;
  const input = completed.response;
  // The page's authorized source labels decorate coverage without changing
  // any accounting/pricing input. Other changed members invalidate the work.
  const fields = ['contributions', 'totals', 'series', 'breakdowns', 'leaders', 'modelTimeline', 'engineTimeline', 'insights', 'priceCatalog'] as const;
  return fields.every(field => input[field] === response[field])
    && input.coverage?.status === response.coverage?.status
    && input.coverage?.reasons === response.coverage?.reasons
    && input.coverage?.ranked === response.coverage?.ranked ? completed : undefined;
}

function selectionMode(selection: UsagePageCostSelection): UsageCostMode {
  return selection.mode ?? (selection.kind === 'invoice' || selection.kind === 'mixed' ? 'auto' : selection.kind);
}

export function resolveUsageCostBasisForSelection(cost: UsageObservationCost, selection: UsagePageCostSelection | null): UsageSelectedCostBasis | null {
  if (!selection) return null;
  const fact = selection.mode === 'auto' || selection.kind === 'mixed' ? resolveUsageCostBasis(cost, 'auto')
    : selection.kind === 'invoice' ? resolveUsageCostFacts(cost).find(fact => fact.kind === 'invoice')
    : resolveUsageCostBasis(cost, selectionMode(selection));
  return fact && (selection.mode === 'auto' || selection.kind === 'mixed' || fact.kind === selection.kind)
    && fact.currency === selection.currency ? fact : null;
}

export function resolveUsageCostForSelection(cost: UsageObservationCost, selection: UsagePageCostSelection | null): number | null {
  return resolveUsageCostBasisForSelection(cost, selection)?.amountUsd ?? null;
}

/** Selection remains named even when an unpriced row makes the total unavailable. */
export function resolveUsagePageCostSelection(costs: readonly UsageObservationCost[], mode: UsageCostMode): UsagePageCostSelection | null {
  const facts = costs.flatMap(cost => { const fact = resolveUsageCostBasis(cost, mode); return fact ? [fact] : []; });
  const first = facts[0];
  return first ? { kind: facts.every(fact => fact.kind === first.kind) ? first.kind : 'mixed', currency: first.currency, mode } : null;
}

/**
 * Best available resolves reported -> API-priced -> estimated for every contribution and keeps
 * a mixed aggregate labelled. Explicit modes and unknown money remain unavailable. Raw facts
 * and query-time tariffs remain unchanged; leaders and buckets use the same aggregation owner.
 */
export function projectUsagePageCost(response: UsageAnalyticsQueryResponse, mode: UsageCostMode,
  selected?: UsagePageCostSelection | null): UsagePageCostProjection {
  const rows = response.contributions;
  const completed = readUsagePageCostProjectionBasis(response);
  const retain = (projection: UsagePageCostProjection) => {
    if (selected === undefined && completed?.mode === mode) {
      completed.pageInput = response;
      completed.pageProjection = projection;
    }
    return projection;
  };
  if (selected === undefined && completed?.mode === mode && completed.pageProjection) {
    const previous = completed.pageProjection;
    if (completed.pageInput === response) return previous;
    const projected = previous.accounting;
    return retain({ ...previous, accounting: { ...response, totals: projected.totals,
      series: projected.series, breakdowns: projected.breakdowns, leaders: projected.leaders,
      modelTimeline: projected.modelTimeline, engineTimeline: projected.engineTimeline,
      coverage: projected.coverage && { ...response.coverage!, status: projected.coverage.status,
        reasons: projected.coverage.reasons, ranked: projected.coverage.ranked },
    } });
  }
  // Raw aggregate facts cannot reconstruct per-row selection after JSON transport.
  // Responses without contribution detail already carry the selected presentation.
  const presentation = response.costPresentation;
  if (!rows && presentation?.mode === mode) {
    const rawBasis = resolveUsageCostBasis(response.totals.cost, mode);
    const kind = mode === 'auto' ? rawBasis?.source === presentation.source ? rawBasis.kind : 'mixed' : mode;
    const selection = selected === undefined ? { kind, currency: presentation.currency, mode } : selected;
    const matches = selection && selection.currency === presentation.currency && selectionMode(selection) === mode
      && (selection.mode === 'auto' || selection.kind === 'mixed' || selection.kind === kind);
    return { selection, amountUsd: matches ? presentation.effectiveUsd : null, accounting: response };
  }
  const costs = (rows ? resolveUsageContributionCosts(rows, mode) : [response.totals.cost])
    .filter(cost => !(cost as AggregatedUsageCost)[usageCostAggregationBasis]?.covered);
  const selection = selected === undefined ? resolveUsagePageCostSelection(costs, mode) : selected;
  const amounts = costs.map(cost => resolveUsageCostForSelection(cost, selection));
  const amountUsd = selection && amounts.length > 0 && amounts.every(amount => amount !== null)
    ? amounts.reduce<number>((sum, amount) => sum + amount!, 0) : null;
  if (!rows || !selection) return retain({ selection, amountUsd, accounting: response });
  const selectedMode = selectionMode(selection);
  const projectCost = (raw: UsageObservationCost, contributions: readonly UsageAnalyticsContribution[]): UsageObservationCost => {
    const selectedCosts = resolveUsageContributionCosts(contributions, selectedMode)
      .filter(cost => !(cost as AggregatedUsageCost)[usageCostAggregationBasis]?.covered);
    const amounts = selectedCosts.map(cost => resolveUsageCostForSelection(cost, selection));
    const { effectiveUsd: _old, ...original } = raw;
    if (selectedCosts.length === 0 || amounts.some(amount => amount === null)) {
      const unavailable: AggregatedUsageCost = { ...original, costSource: 'none',
        [usageCostAggregationBasis]: { mode: selectedMode, available: false } };
      return unavailable;
    }
    return aggregateUsageContributionCosts(contributions, selectedMode);
  };
  const ranking = reprojectUsageLeaders(response, rows, selectedMode, projectCost);
  const projection = { selection, amountUsd, accounting: { ...response, ...ranking,
    totals: { ...response.totals, cost: projectCost(response.totals.cost, rows) },
  } };
  return retain(projection);
}

/** All observed monetary kinds remain separate, including simultaneous facts. */
export function resolveUsageCostFacts(cost: UsageObservationCost): UsageCostBasis[] {
  const reportedSource = cost.costSource === 'provider_reported_api_equivalent' ? 'provider_reported_api_equivalent' : 'provider_reported';
  const hasReported = cost.reportedUsd > 0 || cost.costSource === 'provider_reported' || cost.costSource === 'provider_reported_api_equivalent';
  const hasEstimated = cost.estimatedUsd > 0 || cost.costSource === 'pricing_estimate';
  const hasInvoice = (cost.invoiceUsd ?? 0) > 0 || cost.costSource === 'invoice';
  const basis = (kind: UsageCostBasis['kind'], amountUsd: number, source: string): UsageCostBasis => ({ kind, amountUsd, currency: cost.currency, source });
  const facts: UsageCostBasis[] = [];
  if (hasReported) facts.push(basis('reported', cost.reportedUsd, reportedSource));
  if (hasEstimated) facts.push(basis('estimated', cost.estimatedUsd, 'pricing_estimate'));
  if (hasInvoice) facts.push(basis('invoice', cost.invoiceUsd ?? 0, 'invoice'));
  if (cost.apiEquivalentUsd !== undefined) facts.push({ kind: 'api_equivalent', currency: 'USD', amountUsd: cost.apiEquivalentUsd, source: cost.pricingSource ?? 'catalog' });
  return facts;
}

/** A monetary value is available only when its selected basis is witnessed. */
export function resolveUsageCostBasis(cost: UsageObservationCost, mode: UsageCostMode): UsageSelectedCostBasis | null {
  const aggregation = (cost as AggregatedUsageCost)[usageCostAggregationBasis];
  if (aggregation?.mode === mode) {
    return aggregation.available ? aggregation.selected ?? null : null;
  }
  if (isUsageCostCoveredByReportedTotal(cost, mode)) return null;
  if (cost.reportedTotalContributionIds && (mode === 'auto' || mode === 'reported')) return null;
  if (mode === 'api_equivalent') return cost.apiEquivalentUsd === undefined ? null
    : { kind: 'api_equivalent', currency: 'USD', amountUsd: cost.apiEquivalentUsd, source: cost.pricingSource ?? 'catalog' };
  if (cost.currency === 'MIXED' || cost.costSource === 'none' && cost.apiEquivalentUsd === undefined) return null;
  return resolveUsageCostFactForMode(resolveUsageCostFacts(cost), mode) ?? null;
}

/** Legacy numeric adapter; absence is represented by the result's omitted presentation. */
export function resolveEffectiveUsageCostUsd(cost: UsageObservationCost, mode: UsageCostMode): number {
  return resolveUsageCostBasis(cost, mode)?.amountUsd ?? 0;
}

export function resolveUsageCostPresentationSource(cost: UsageObservationCost, mode: UsageCostMode): string {
  return resolveUsageCostBasis(cost, mode)?.source ?? 'none';
}

/** One grouping key is used by both query aggregation and price reprojection. */
export function resolveUsageContributionDimensionKey(row: Pick<UsageAnalyticsContribution,
  'agentId' | 'modelId' | 'sessionId' | 'projectKey' | 'workspaceId' | 'backendMode' | 'source'> & { machineId?: string | null },
  dimension: NonNullable<UsageAnalyticsQueryRequest['breakdowns']>[number] | 'engine'): string | null {
  if (dimension === 'engine') return row.agentId ? row.backendMode ? `${row.agentId}:${row.backendMode}` : row.agentId : null;
  if (dimension === 'model') return canonicalUsageModelPriceId(row.modelId);
  const fields = { agent: 'agentId', model: 'modelId', session: 'sessionId', project: 'projectKey', workspace: 'workspaceId',
    machine: 'machineId', backendMode: 'backendMode', source: 'source' } as const;
  return row[fields[dimension]] ?? null;
}
