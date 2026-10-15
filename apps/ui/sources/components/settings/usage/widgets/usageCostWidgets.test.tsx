import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { HappierDataMetric, RankedRows, StackedSeriesChart } from '@happier-dev/plugin-ui/presentation';
import { normalizeUsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveUsagePageAggregation } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { projectUsagePageCost, resolveUsageCostForSelection, repriceUsageAnalyticsResponse, type UsageAnalyticsContribution } from '@happier-dev/protocol';
import { allocateUsageOutcomes } from '@happier-dev/protocol/usage/usageOutcomeAllocation';
import { summarizeUsageWork } from './usageWorkPresentation';
import { usagePageCostTrend } from '../usageCostPresentation';
import { renderScreen } from '@/dev/testkit';
import { t } from '@/text';
import { UsagePeriodSummaryWidget } from './UsagePeriodSummaryWidget';
import { UsageCostFactsWidget } from './UsageCostFactsWidget';
import { UsageDailyWidget } from './UsageDailyWidget';
import { UsageFlowWidget } from './UsageFlowWidget';
import { UsageBreakdownsWidget } from './UsageBreakdownsWidget';
import { leadingUsageRows, UsageShowAllRows } from './usageBodyKit';
import { usageQaAccountingFixture } from '@/dev/testkit/fixtures/usageQaAccountingFixture';
import { UsageEfficiencyWidget } from './UsageEfficiencyWidget';
import type { UsageWidgetBodyModel } from '../useUsageWidgetResource';

const day = 86_400_000;
const tokens = { input: 10, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 10 };
function mountedCosts(unpriced = false) {
  const query = normalizeUsageQuery({ period: { startMs: 0, endMs: day }, metric: 'cost', costBasis: 'auto', breakdown: ['agent'] });
  const contributions: UsageAnalyticsContribution[] = [
    { id: 'a', sessionId: 's', turnId: 'a', observedAtMs: 1, eventCount: 1, agentId: 'claude', modelId: 'unknown-a',
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' }, tokens,
      cost: { reportedUsd: 1, estimatedUsd: 0.5, invoiceUsd: 0.2, currency: 'USD' } },
    { id: 'b', sessionId: 's', turnId: 'b', observedAtMs: 2, eventCount: 1, agentId: 'claude', modelId: 'unknown-b',
      machineId: null, projectKey: null, workspaceId: null, source: 'runtime', sourceContext: { path: 'runtime', execution: 'happier' }, tokens,
      cost: unpriced ? { reportedUsd: 0, estimatedUsd: 0, currency: 'USD', costSource: 'none' }
        : { reportedUsd: 2, estimatedUsd: 0.7, currency: 'USD' } },
  ];
  const cost = { reportedUsd: unpriced ? 1 : 3, estimatedUsd: unpriced ? 0.5 : 1.2, invoiceUsd: 0.2, currency: 'USD', costSource: 'none' as const };
  const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: repriceUsageAnalyticsResponse({
    v: 1, totals: { eventCount: 2, tokens: { ...tokens, input: 20, total: 20 }, cost }, contributions,
    series: [{ bucketStartMs: 0, bucketEndMs: day, eventCount: 2, tokens: { ...tokens, input: 20, total: 20 }, cost }],
    breakdowns: { agent: [{ key: 'claude', eventCount: 2, tokens: { ...tokens, input: 20, total: 20 }, cost }] },
    engineTimeline: [{ bucketStartMs: 0, bucketEndMs: day, leaders: [{ key: 'claude', eventCount: 2,
      tokens: { ...tokens, input: 20, total: 20 }, cost }] }],
  }) }] }).results[0]!;
  const identity = { query, authority: { serverId: 'home', accountId: 'usage-account' } };
  const model: UsageWidgetBodyModel = { requestedQuery: identity, shownQuery: identity, slice, pending: false, error: null,
    freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
  return { query, slice, model, serverId: 'home' };
}

describe('one selected money basis across Usage bodies', () => {
  it('keeps the Agent time slot stable and publishes only complete interval figures', async () => {
    const props = mountedCosts();
    const query = normalizeUsageQuery({ ...props.query, includeSessionEvidence: true });
    const accounting = [{ query, status: 'available' as const, value: props.slice.accounting! }];
    const cold = resolveUsagePageAggregation({ queries: [query], accounting });
    const facts = [{ workId: 'work', evidenceId: 'turn', agentId: null, machineId: null,
      kind: 'busy' as const, startMs: 0, endMs: 3_600_000 }];
    const partial = resolveUsagePageAggregation({ queries: [query], accounting,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'partial', facts: facts.map(fact => ({ ...fact, endMs: null })) } }] });
    const complete = resolveUsagePageAggregation({ queries: [query], accounting,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'available', facts } }] });
    // Transcript coverage can be partial while every admitted busy interval is
    // closed. Completeness of this duration belongs to the interval facet.
    const completeIntervals = resolveUsagePageAggregation({ queries: [query], accounting,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'partial', facts } }] });
    const pending = resolveUsagePageAggregation({ queries: [query], accounting, previous: complete,
      sources: [{ source: 'how_you_work', status: 'pending' }] });
    const refused = resolveUsagePageAggregation({ queries: [query], accounting, previous: complete,
      howYouWork: [{ query, asOfMs: day, detail: { status: 'unknown' } }] });
    const screen = await renderScreen(<UsagePeriodSummaryWidget {...props} query={query}
      slice={cold.results[0]!} id="usage_period_summary" testID="summary" />);
    const statLabels = () => screen.findAllByType(HappierDataMetric)
      .filter(metric => metric.props.size === 'stat').map(metric => metric.props.label);
    const expectedLabels = [t('usage.cost'), t('usage.board.page.mergedPrs'), t('usage.board.page.agentTime')];
    for (const [batch, expected] of [[cold, '—'], [partial, '—'], [complete, 1], [completeIntervals, 1], [pending, 1], [partial, '—'], [refused, '—']] as const) {
      await screen.update(<UsagePeriodSummaryWidget {...props} query={query}
        slice={batch.results[0]!} id="usage_period_summary" testID="summary" />);
      expect(statLabels()).toEqual(expectedLabels);
      expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.label === t('usage.board.page.agentTime'))?.props.value)
        .toBe(expected);
      // A dash carries its quiet reason in the caption slot, so the three cells stay even.
      const stat = (label: string) => screen.findAllByType(HappierDataMetric).find(metric => metric.props.label === label)!;
      expect(stat(t('usage.board.page.agentTime')).props.caption === t('usage.board.page.notMeasuredYet')).toBe(expected === '—');
      expect(stat(t('usage.board.page.mergedPrs')).props.caption).toEqual(expect.any(String));
    }
  });
  it('uses reported then priced money per real QA row across Daily, Flow, Breakdowns, Leaders, Efficiency and Work', async () => {
    const query = normalizeUsageQuery({ metric: 'cost', breakdown: ['agent'], timeZoneOffsetMinutes: 120 });
    const captured = usageQaAccountingFixture();
    const candidates = [...new Set(captured.contributions!.map(row => row.agentId ?? 'unknown'))]
      .map(key => ({ key, eventCount: 1, tokens, cost: captured.totals.cost }));
    const accounting = repriceUsageAnalyticsResponse({ ...captured,
      breakdowns: { ...captured.breakdowns, agent: candidates }, leaders: { ...captured.leaders, agents: candidates },
    });
    const rows = accounting.contributions!;
    const claudeCost = rows.filter(row => row.agentId === 'claude')
      .reduce((sum, row) => sum + (row.cost.apiEquivalentUsd ?? row.cost.estimatedUsd), 0);
    const reportedCost = captured.totals.cost.reportedUsd;
    const total = claudeCost + reportedCost;
    const page = projectUsagePageCost(accounting, 'auto');
    expect(page.amountUsd).toBeCloseTo(total);
    expect(page.selection).toMatchObject({ kind: 'mixed', currency: 'USD' });
    expect(usagePageCostTrend(page).reduce((sum, point) => sum + (point.cost ?? 0), 0)).toBeCloseTo(total);
    const expectedRowCost = (agentId: string) => rows.filter(row => (row.agentId ?? 'unknown') === agentId)
      .reduce((sum, row) => sum + (row.cost.reportedUsd || row.cost.apiEquivalentUsd || row.cost.estimatedUsd), 0);
    for (const entries of [page.accounting.breakdowns!.agent!, page.accounting.leaders!.agents!]) {
      for (const row of entries) expect(resolveUsageCostForSelection(row.cost!, page.selection)).toBeCloseTo(expectedRowCost(row.key));
    }
    expect(resolveUsageCostForSelection(page.accounting.breakdowns!.model!.find(row => row.key === 'unknown')!.cost, page.selection)).toBeCloseTo(reportedCost);
    const summary = summarizeUsageWork(allocateUsageOutcomes({ contributions: rows, evidence: [] }), { metric: 'cost', costBasis: 'auto' });
    expect(summary.total).toBeCloseTo(total);
    expect(summary.moneyBasis).toMatchObject({ kind: 'mixed', currency: 'USD' });
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }).results[0]!;
    const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
    const props = { query, slice, model, serverId: 'home' };
    const screen = await renderScreen(<>
      <UsageDailyWidget {...props} id="usage_daily" testID="qa-cost-daily" />
      <UsageFlowWidget {...props} id="usage_flow" testID="qa-cost-flow" />
      <UsageBreakdownsWidget {...props} id="usage_breakdowns" testID="qa-cost-breakdowns" />
      <UsageEfficiencyWidget {...props} id="usage_efficiency" testID="qa-cost-efficiency" />
    </>);
    for (const chart of screen.findAllByType(StackedSeriesChart)) {
      const values = chart.props.series.flatMap((series: { points: { y: number | null }[] }) => series.points.map(point => point.y));
      expect(values.some((value: number | null) => value !== null && value > 0)).toBe(true);
      expect(values.reduce((sum: number, value: number | null) => sum + (value ?? 0), 0)).toBeCloseTo(total);
    }
    expect(screen.findByType(RankedRows).props.rows.find((row: { id: string }) => row.id === 'claude').value).toBeCloseTo(expectedRowCost('claude'));
    expect(screen.findByType(RankedRows).props.rows.find((row: { id: string }) => row.id === 'claude').annotation)
      .toContain(t('usage.board.page.kindMixed'));
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'qa-cost-efficiency.perMtok')?.props.value)
      .toBeCloseTo(total / captured.totals.tokens.total * 1e6);
  });
  it('groups the real QA Haiku aliases once, conserves their tokens, and keeps Haiku 5.5 distinct', async () => {
    const query = normalizeUsageQuery({ breakdown: ['model'], metric: 'tokens' });
    const accounting = usageQaAccountingFixture();
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: accounting }] }).results[0]!;
    const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
    const screen = await renderScreen(<UsageBreakdownsWidget query={query} slice={slice} model={model} serverId="home" id="usage_breakdowns" testID="qa-models" />);
    const rows = screen.findByType(RankedRows).props.rows as { id: string; label: string; value: number }[];
    expect(rows.filter(row => row.label === 'Haiku 4.5')).toEqual([expect.objectContaining({ id: 'claude-haiku-4-5', value: 2773382 })]);
    expect(rows.find(row => row.id === 'claude-haiku-5-5')).toMatchObject({ label: 'Haiku 5.5', value: 299832 });
    expect(rows.reduce((sum, row) => sum + row.value, 0)).toBe(accounting.totals.tokens.total);
    expect(slice.accounting!.coverage!.ranked.find(row => row.dimension === 'model')).toMatchObject({ totalEntries: 5, returnedEntries: 5, complete: true });
  });
  it('distinguishes a folded returned ranking from the three real QA machines omitted by the query', async () => {
    const query = normalizeUsageQuery({ breakdown: ['machine'], metric: 'tokens' });
    const slice = resolveUsagePageAggregation({ queries: [query], accounting: [{ query, status: 'available', value: usageQaAccountingFixture() }] }).results[0]!;
    const model: UsageWidgetBodyModel = { requestedQuery: null, shownQuery: null, slice, pending: false, error: null,
      freshness: 'fresh', updatingPreviousPeriod: false, refreshing: false, refresh: async () => {} };
    const screen = await renderScreen(<UsageBreakdownsWidget query={query} slice={slice} model={model} serverId="home" id="usage_breakdowns" testID="qa-machines" />);
    expect(screen.findByType(RankedRows).props.rows).toHaveLength(6);
    expect(screen.findByType(UsageShowAllRows).props).toMatchObject({ total: 20, complete: false });
    expect(screen.getTextContent()).toContain(`${t('usage.showAvailable')} · 20`);
    expect(screen.getTextContent()).toContain(t('usage.board.page.moreRows', { count: 3 }));
    await screen.pressByTestIdAsync('qa-machines.machine.more');
    expect(screen.findByType(RankedRows).props.rows).toHaveLength(20);
    expect(slice.accounting!.coverage!.ranked.find(row => row.dimension === 'machine')).toMatchObject({ totalEntries: 23, returnedEntries: 20, complete: false });
  });
  it('uses selected page money rather than a legacy fallback for cost per million tokens', async () => {
    const props = mountedCosts();
    const screen = await renderScreen(<UsageEfficiencyWidget {...props} id="usage_efficiency" testID="efficiency" />);
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'efficiency.perMtok')?.props.value)
      .toBe(150_000);
  });
  it('keeps all four efficiency figures in their slots, an unknown one as a dash with its reason', async () => {
    const props = mountedCosts();
    const screen = await renderScreen(<UsageEfficiencyWidget {...props} id="usage_efficiency" testID="efficiency" />);
    const metrics = screen.findAllByType(HappierDataMetric).filter(metric => String(metric.props.testID).startsWith('efficiency.'));
    expect(metrics.map(metric => metric.props.testID)).toEqual(['efficiency.cacheHit', 'efficiency.perMtok', 'efficiency.perMergedPr', 'efficiency.noKeptChange']);
    // No merged PR is linked in this slice, and nothing measures work that kept no change: each is a dash that says why.
    expect(metrics.slice(2).map(metric => [metric.props.value, metric.props.caption]))
      .toEqual([['—', t('usage.board.page.noneLinkedByEvidence')], ['—', t('usage.board.page.notMeasuredYet')]]);
  });
  it('uses the common reported basis rather than mixing one invoice with another reported charge', async () => {
    const props = mountedCosts();
    const screen = await renderScreen(<>
      <UsagePeriodSummaryWidget {...props} id="usage_period_summary" testID="summary" />
      <UsageCostFactsWidget {...props} id="usage_cost_facts" testID="facts" />
      <UsageDailyWidget {...props} id="usage_daily" testID="daily" />
      <UsageFlowWidget {...props} id="usage_flow" testID="flow" />
      <UsageBreakdownsWidget {...props} id="usage_breakdowns" testID="breakdown" />
    </>);
    const metrics = screen.findAllByType(HappierDataMetric);
    expect(metrics.find(metric => metric.props.testID === 'summary.hero')?.props.value).toBe(3);
    expect(metrics.find(metric => metric.props.testID === 'facts.fact.invoice')?.props.value).toBe(0.2);
    expect(metrics.find(metric => metric.props.testID === 'facts.fact.reported')?.props.value).toBe(3);
    expect(screen.findAllByType(StackedSeriesChart).map(chart => chart.props.series.reduce(
      (sum: number, entry: { points: { y: number }[] }) => sum + entry.points[0]!.y, 0))).toEqual([3, 3]);
    expect(screen.findByType(RankedRows).props.rows.map((row: { value: number }) => row.value)).toEqual([3]);
  });

  it('keeps missing selected money unavailable instead of drawing a zero total or row', async () => {
    const props = mountedCosts(true);
    const screen = await renderScreen(<>
      <UsagePeriodSummaryWidget {...props} id="usage_period_summary" testID="summary" />
      <UsageDailyWidget {...props} id="usage_daily" testID="daily" />
      <UsageFlowWidget {...props} id="usage_flow" testID="flow" />
      <UsageBreakdownsWidget {...props} id="usage_breakdowns" testID="breakdown" />
    </>);
    // Unknown money is a quiet dash with its reason as the caption, never a headline word.
    expect(screen.findAllByType(HappierDataMetric).find(metric => metric.props.testID === 'summary.hero')?.props.value).toBe('—');
    expect(screen.getTextContent()).toContain(t('common.unavailable'));
    expect(screen.findByType(RankedRows).props.rows[0].value).toBeNull();
    expect(screen.findAllByType(StackedSeriesChart).flatMap(chart => chart.props.series)
      .every((entry: { points: { y: number | null }[] }) => entry.points.every(point => point.y === null))).toBe(true);
  });

  it('leads a long breakdown with its largest rows and keeps the tail one press away', () => {
    const rows = Array.from({ length: 16 }, (_, index) => ({ id: `m${index}` }));
    expect(leadingUsageRows(rows, false)).toEqual({ rows: rows.slice(0, 6), hidden: 10 });
    expect(leadingUsageRows(rows, true)).toEqual({ rows, hidden: 0 });
    // A list that is only a little longer shows whole: a disclosure for one or two rows is noise.
    expect(leadingUsageRows(rows.slice(0, 8), false)).toEqual({ rows: rows.slice(0, 8), hidden: 0 });
  });
});
