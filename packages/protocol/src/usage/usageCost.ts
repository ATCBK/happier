import type { UsageAnalyticsContribution, UsageAnalyticsCostFact, UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageObservationCost, UsageObservationTokens } from './usageAnalyticsContracts.js';
import { bundledUsageModelPriceCatalog, resolveUsageModelPrice, type ResolvedUsageModelPrice, type UsageModelPriceCatalog, type UsageModelPriceOverridesV1 } from './usageModelPriceCatalog.js';
import { resolveUsageTokenCategories } from './usageTokenCategories.js';
import { projectUsageCostFactTotals } from './usageCostFactTotals.js';
import { reprojectUsageLeaders } from './usageLeaderProjection.js';
import { aggregateUsageContributionCosts } from './usageAggregation.js';

import { resolveUsageCostBasis, resolveUsageCostFacts, readUsagePageCostProjectionBasis, usagePageCostProjectionBasis, type UsageCostMode } from './usageCostFacts.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
export * from './usageCostFacts.js';

/** Standard catalog USD tariff over nonoverlapping token categories, never an invoice. */
export interface UsageModelCostEstimate {
  total: number;
  input: number;
  output: number;
  estimatedUsd: number;
  price: ResolvedUsageModelPrice;
  breakdown?: Readonly<{ cacheSavingsUsd: number }>;
}

export function estimateUsageModelCost(modelId: string | null | undefined, categories: UsageObservationTokens | null,
  catalog: UsageModelPriceCatalog = bundledUsageModelPriceCatalog, overrides: UsageModelPriceOverridesV1 = {}): UsageModelCostEstimate | null {
  const price = resolveUsageModelPrice(modelId, catalog, overrides);
  if (!price || !categories) return null;
  const { rates } = price;
  if (categories.cacheRead > 0 && rates.cacheReadUsdPerMillion === undefined
    || categories.cacheWrite > 0 && rates.cacheWriteUsdPerMillion === undefined) return null;
  const input = (categories.input * rates.inputUsdPerMillion + categories.cacheRead * (rates.cacheReadUsdPerMillion ?? 0)
    + categories.cacheWrite * (rates.cacheWriteUsdPerMillion ?? 0)) / 1_000_000;
  const output = (categories.output * rates.outputUsdPerMillion + categories.reasoning * (rates.reasoningUsdPerMillion ?? rates.outputUsdPerMillion)) / 1_000_000;
  const total = input + output;
  if (!Number.isFinite(total)) return null;
  const cacheSavingsUsd = categories.cacheRead * (rates.inputUsdPerMillion - (rates.cacheReadUsdPerMillion ?? rates.inputUsdPerMillion)) / 1_000_000;
  return { total, input, output, estimatedUsd: total, price,
    ...(cacheSavingsUsd > 0 ? { breakdown: { cacheSavingsUsd } } : {}) };
}

/** Query-only price projection. Original reported/invoice/legacy estimate fields are immutable inputs. */
export function repriceUsageObservationCost(rawCost: UsageObservationCost, modelId: string | null | undefined,
  categories: UsageObservationTokens | null, catalog: UsageModelPriceCatalog = bundledUsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1 = {}, mode: UsageCostMode = 'auto'): UsageObservationCost {
  const estimate = estimateUsageModelCost(modelId, categories, catalog, overrides);
  const { apiEquivalentUsd: _old, pricingSource: _source, effectiveUsd: _effective, ...raw } = rawCost;
  const source = estimate ? estimate.price.source === 'catalog' ? `litellm:${catalog.provenance.revision}`
    : `user:${estimate.price.source}:${modelId}` : undefined;
  // A money-only observation adds no token-tariff population. Its unknown model
  // must not make otherwise fully priced tokens incomplete.
  const noTokens = categories !== null && Object.values(categories).every(value => value === 0);
  const priced = estimate ? { ...raw, apiEquivalentUsd: estimate.total, pricingSource: source }
    : noTokens ? { ...raw, apiEquivalentUsd: 0, pricingSource: 'no_tokens' } : raw;
  const selected = resolveUsageCostBasis(priced, mode);
  return selected ? { ...priced, effectiveUsd: selected.amountUsd } : priced;
}

/** Recompute history from the admitted contribution projection, retaining the original money facts. */
export function repriceUsageAnalyticsResponse(value: UsageAnalyticsQueryResponse, catalog: UsageModelPriceCatalog = value.priceCatalog ?? bundledUsageModelPriceCatalog,
  overrides: UsageModelPriceOverridesV1 = {}, mode: UsageCostMode = 'auto'): UsageAnalyticsQueryResponse {
  if (!value.contributions) return { ...value, priceCatalog: catalog };
  const completed = readUsagePageCostProjectionBasis(value);
  if (completed?.mode === mode && completed.catalog === catalog && sameStrictJsonValue(completed.overrides, overrides)) return value;
  const facts: UsageAnalyticsCostFact[] = [];
  let cacheSavingsUsd = 0;
  let cacheSavingsComplete = true;
  const contributions = value.contributions.map(row => {
    const categories = row.tokenCategories ?? resolveUsageTokenCategories(row.tokens, null);
    const estimate = estimateUsageModelCost(row.modelId, categories, catalog, overrides);
    if (!estimate && row.tokens.cacheRead > 0) cacheSavingsComplete = false;
    cacheSavingsUsd += estimate?.breakdown?.cacheSavingsUsd ?? 0;
    const cost = repriceUsageObservationCost(row.cost, row.modelId, categories, catalog, overrides, mode);
    const existing = resolveUsageCostFacts(cost);
    const base = { tokens: row.tokens, eventCount: row.eventCount ?? 1, asOfMs: row.observedAtMs,
      complete: row.eventCount !== undefined && value.coverage?.status === 'complete' };
    for (const fact of existing) facts.push({ ...base, ...fact, currency: fact.kind === 'api_equivalent' ? 'USD' : fact.currency });
    if (!estimate && row.tokens.total > 0) facts.push({ ...base, kind: 'unpriced', currency: 'USD', amountUsd: null,
      source: categories ? 'model_price_unknown' : 'token_categories_unknown', complete: false });
    return { ...row, cost };
  });
  const totalCost = aggregateUsageContributionCosts(contributions, mode);
  const projectCost = (raw: UsageObservationCost, rows: readonly UsageAnalyticsContribution[]): UsageObservationCost => {
    const { apiEquivalentUsd: _old, pricingSource: _source, effectiveUsd: _effective, ...observed } = raw;
    const allPriced = rows.every(row => row.cost.apiEquivalentUsd !== undefined);
    const updated: UsageObservationCost = allPriced ? { ...observed,
      apiEquivalentUsd: rows.reduce((sum, row) => sum + row.cost.apiEquivalentUsd!, 0),
      pricingSource: rows.every(row => row.cost.pricingSource === rows[0]?.cost.pricingSource)
        ? rows[0]?.cost.pricingSource ?? `litellm:${catalog.provenance.revision}` : 'effective_model_prices',
    } : observed;
    const selected = resolveUsageCostBasis(rows === contributions ? totalCost : aggregateUsageContributionCosts(rows, mode), mode);
    return selected ? { ...updated, effectiveUsd: selected.amountUsd } : updated;
  };
  const ranking = reprojectUsageLeaders(value, contributions, mode, projectCost);
  const totals = { ...value.totals, cost: projectCost(value.totals.cost, contributions) };
  const selected = resolveUsageCostBasis(totalCost, mode);
  const costPresentation = selected ? { mode, effectiveUsd: selected.amountUsd, currency: selected.currency, source: selected.source } : undefined;
  const factGroups = new Map<string, UsageAnalyticsCostFact[]>();
  for (const fact of facts) {
    const key = JSON.stringify([fact.kind, fact.currency, fact.source]);
    const group = factGroups.get(key);
    if (group) group.push(fact); else factGroups.set(key, [fact]);
  }
  const groupedFacts = [...factGroups.values()].map(group => {
    const { sources, ...fact } = projectUsageCostFactTotals(group)[0]!;
    return { ...fact, source: sources[0]! };
  });
  const unknown = groupedFacts.some(fact => fact.kind === 'unpriced');
  const coverage = ranking.coverage && { ...ranking.coverage, status: unknown && ranking.coverage.status === 'complete' ? 'partial' as const : ranking.coverage.status,
    reasons: [...ranking.coverage.reasons.filter(reason => reason !== 'unpriced_tokens'), ...(unknown ? ['unpriced_tokens' as const] : [])] };
  let insights = value.insights;
  if (insights) {
    const { cacheSavingsUsd: _oldSavings, ...otherInsights } = insights;
    insights = { ...otherInsights, ...(cacheSavingsComplete ? { cacheSavingsUsd } : {}) };
  }
  const response = { ...value, totals, contributions, costFacts: groupedFacts, priceCatalog: catalog, costPresentation, coverage, insights,
    series: ranking.series,
    breakdowns: ranking.breakdowns, leaders: ranking.leaders, modelTimeline: ranking.modelTimeline, engineTimeline: ranking.engineTimeline };
  Object.defineProperty(totals.cost, usagePageCostProjectionBasis, { value: { response, mode, catalog, overrides } });
  return response;
}
