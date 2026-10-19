import { describe, expect, it } from 'vitest';
import { getUsageQueryKey, normalizeUsageQuery, usageAnalyticsRequestToQuery, usageQueryToAnalyticsRequest, UsageQuerySchema, USAGE_QUERY_INPUT_FIELDS, readUsagePeriodOptions } from './usageQuery.js';
import { UsageAnalyticsQueryRequestSchema } from '../usage/usageAnalyticsContracts.js';
import { InputFieldHintSchema } from './inputFields.js';
import { resolveEffectiveInputFields } from './inputFieldRuntime.js';
import { projectInputOptionsDependencies } from './inputOptionsDependencies.js';

describe('shared UsageQuery', () => {
  it('keeps quota-only demand distinct and out of the accounting transport', () => {
    const full = normalizeUsageQuery({});
    const quota = normalizeUsageQuery({ includeAccounting: false });
    expect(getUsageQueryKey(quota)).not.toBe(getUsageQueryKey(full));
    expect(usageQueryToAnalyticsRequest(quota)).not.toHaveProperty('includeAccounting');
  });
  it('keys Session evidence demand without forwarding it to the accounting server', () => {
    const full = normalizeUsageQuery({});
    const accountingOnly = normalizeUsageQuery({ includeSessionEvidence: false, includeWorkEvidence: false, includeInsights: true });
    expect(full.includeSessionEvidence).toBe(true);
    expect(full.includeWorkEvidence).toBe(true);
    expect(getUsageQueryKey({})).toBe(getUsageQueryKey({ includeSessionEvidence: true }));
    expect(getUsageQueryKey(accountingOnly)).not.toBe(getUsageQueryKey({ includeInsights: true }));
    expect(usageQueryToAnalyticsRequest(accountingOnly)).toMatchObject({ includeInsights: true });
    expect(usageQueryToAnalyticsRequest(accountingOnly)).not.toHaveProperty('includeSessionEvidence');
    expect(usageQueryToAnalyticsRequest(accountingOnly)).not.toHaveProperty('includeWorkEvidence');
  });
  it('separates transcript demand from Session evidence and keeps it off the accounting transport', () => {
    const summaryOnly = normalizeUsageQuery({ includeTranscriptEvidence: false });
    expect(normalizeUsageQuery({}).includeTranscriptEvidence).toBe(true);
    expect(summaryOnly.includeSessionEvidence).toBe(true);
    expect(getUsageQueryKey({})).toBe(getUsageQueryKey({ includeTranscriptEvidence: true }));
    expect(getUsageQueryKey(summaryOnly)).not.toBe(getUsageQueryKey({}));
    expect(UsageAnalyticsQueryRequestSchema.safeParse(usageQueryToAnalyticsRequest(summaryOnly)).success).toBe(true);
    expect(usageQueryToAnalyticsRequest(summaryOnly)).not.toHaveProperty('includeTranscriptEvidence');
  });
  it('retains a relative period as semantic input and resolves it at the analytics read clock', () => {
    const now = Date.parse('2026-10-11T20:30:00Z');
    const query = normalizeUsageQuery({ period: { relative: '7days' }, breakdown: ['agent'] });
    expect(query.period).toEqual({ relative: '7days' });
    expect(usageQueryToAnalyticsRequest(query, now).dateRange).toEqual({ startMs: Date.parse('2026-10-05T00:00:00Z'), endMs: now });
    expect(usageQueryToAnalyticsRequest(query, now + 86_400_000).dateRange).toEqual({ startMs: Date.parse('2026-10-06T00:00:00Z'), endMs: now + 86_400_000 });
    expect(getUsageQueryKey(query)).toBe(getUsageQueryKey({ ...query, period: { relative: '7days' } }));
    expect(UsageQuerySchema.safeParse({ period: { relative: '7days', startMs: 100 } }).success).toBe(false);
    expect(usageQueryToAnalyticsRequest(normalizeUsageQuery({ period: { relative: 'today' }, timeZoneOffsetMinutes: 120 }),
      Date.parse('2026-10-11T00:30:00Z')).dateRange).toEqual({ startMs: Date.parse('2026-10-10T22:00:00Z'), endMs: Date.parse('2026-10-11T00:30:00Z') });
    expect(usageQueryToAnalyticsRequest(normalizeUsageQuery({ period: { relative: 'all' } }), now).dateRange).toEqual({ startMs: 0, endMs: now });
    const absolute = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 } });
    expect(usageQueryToAnalyticsRequest(absolute, now).dateRange).toEqual(absolute.period);
  });
  it.each([['7days', 7], ['30days', 30], ['90days', 90], ['year', 365]] as const)('reads %s as exactly %s calendar days including today', (relative, days) => {
    const now = Date.parse('2026-10-11T20:30:00Z');
    const query = normalizeUsageQuery({ period: { relative }, timeZoneOffsetMinutes: 120 });
    expect(usageQueryToAnalyticsRequest(query, now).dateRange).toEqual({
      startMs: Date.parse('2026-10-10T22:00:00Z') - (days - 1) * 86_400_000, endMs: now,
    });
  });
  it('retains Usage choice dependencies for ordinary Action editors, not only widget consumers', () => {
    const query = { period: { startMs: 1, endMs: 2 }, agents: ['claude'], breakdown: ['source', 'machine'] };
    expect(projectInputOptionsDependencies({ query, prompt: 'unrelated' })).toEqual({ query });
    expect(projectInputOptionsDependencies(query)).toEqual(query);
  });
  it('keys equivalent selected sets while preserving every distinct filter and output clause', () => {
    const query = normalizeUsageQuery({ period: { startMs: 100, endMs: 200 }, agents: ['codex', 'claude', 'codex'], session: 'one' });
    expect(getUsageQueryKey(query)).toBe(getUsageQueryKey({ ...query, agents: ['claude', 'codex'], session: ['one'] }));
    for (const change of [{ costBasis: 'reported' }, { metric: 'cost' }, { machines: ['machine'] }, { projects: ['project'] },
      { session: ['two'] }, { sources: ['native'] }, { modelIds: ['model'] }, { includeSeries: false }, { includeInsights: true }, { topLimit: 3 }]) {
      expect(getUsageQueryKey({ ...query, ...change })).not.toBe(getUsageQueryKey(query));
    }
  });
  it('round-trips canonical range, bucket, multiple Session filters and all admitted output flags', () => {
    const request = UsageAnalyticsQueryRequestSchema.parse({ dateRange: { startMs: 100, endMs: 200 }, granularity: 'hour', timeZoneOffsetMinutes: 60,
      filters: { sessionIds: ['two', 'one'], machineIds: ['machine'], modelIds: ['model'], workspaceIds: ['workspace'], backendModes: ['remote'] },
      breakdowns: ['model'], includeSeries: false, includeInsights: true, includeActivity: true, activityResolution: 'weekdayHour', topLimit: 3 });
    const roundTrip = usageQueryToAnalyticsRequest(usageAnalyticsRequestToQuery(request));
    expect(roundTrip).toMatchObject({ ...request, filters: { ...request.filters, sessionIds: ['one', 'two'] } });
    expect(UsageQuerySchema.safeParse({ accountId: 'other' }).success).toBe(false);
  });
  it('declares scope and cost basis independently followable, with own presentation paths', () => {
    const fields = USAGE_QUERY_INPUT_FIELDS.map(field => InputFieldHintSchema.parse(field));
    expect(fields.filter(field => field.contextMode === 'own').map(field => field.path)).toEqual(['metric', 'breakdown']);
    expect(fields.filter(field => field.contextMode === 'follow').map(field => field.path)).toEqual(['period', 'agents', 'machines', 'projects', 'sources', 'session', 'costBasis']);
  });
  it('offers typed multiselect scope choices with an unrestricted empty selection', () => {
    for (const path of ['agents', 'machines', 'projects', 'sources'] as const) {
      const field = USAGE_QUERY_INPUT_FIELDS.find(field => field.path === path)!;
      expect(field.widget).toBe('multiselect');
      expect(field.optionsSourceId).toBe(`usage.filters.${path}`);
      expect(field.placeholder).toBe(`All ${path}`);
      expect(normalizeUsageQuery({ [path]: [] })[path]).toEqual([]);
    }
  });
  it('offers Session editing only when the surface actually declares its Session slot', () => {
    const spec = { inputHints: { fields: [...USAGE_QUERY_INPUT_FIELDS] } };
    const input = normalizeUsageQuery({ session: 'retained-pin' });
    const visible = (contextSlots: readonly string[]) => resolveEffectiveInputFields(spec, input, { contextSlots }).map(field => field.path);
    expect(visible(['period', 'projects'])).not.toContain('session');
    expect(visible(['session'])).toContain('session');
    expect(visible([])).toContain('metric');
    // A standalone query form has no surface contract and can still choose any query scope.
    expect(resolveEffectiveInputFields(spec, input).map(field => field.path)).toContain('session');
    expect(usageQueryToAnalyticsRequest(input).filters?.sessionIds).toEqual(['retained-pin']);
  });
  it('offers the Period as its few named choices in place, keeping a stored custom range nameable (final-acceptance 4)', () => {
    const field = USAGE_QUERY_INPUT_FIELDS.find(field => field.path === 'period')!;
    expect(field.optionsSourceId).toBe('usage.query.period');
    expect(readUsagePeriodOptions(undefined).map(option => option.value)).toEqual(
      ['today', '7days', '30days', '90days', 'year', 'all'].map(relative => ({ relative })));
    const custom = { startMs: 100, endMs: 200 };
    expect(readUsagePeriodOptions(custom).at(-1)?.value).toEqual(custom);
    expect(readUsagePeriodOptions({ relative: '7days' })).toHaveLength(6);
    // The Usage page's unbounded All time is the All time choice, not a second one.
    expect(readUsagePeriodOptions({})).toHaveLength(6);
    expect(readUsagePeriodOptions({}).at(-1)?.value).toEqual({});
  });
  it('offers the user-facing breakdown dimensions without narrowing admitted advanced queries', () => {
    const field = USAGE_QUERY_INPUT_FIELDS.find(field => field.path === 'breakdown')!;
    expect(field.widget).toBe('select');
    expect(field.optionsSourceId).toBe('usage.query.breakdown');
    expect(normalizeUsageQuery({ breakdown: ['session', 'workspace', 'backendMode'] }).breakdown)
      .toEqual(['backendMode', 'session', 'workspace']);
  });
});
