import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createCanonicalJsonSigningInput } from '../crypto/canonicalJson.js';
import { projectNativeJsonValueForTransport } from '../json/strictJsonValue.js';
import { UsageAnalyticsQueryRequestSchema, UsageAnalyticsQueryFiltersSchema, UsageAnalyticsBreakdownDimensionSchema, type UsageAnalyticsQueryRequest } from '../usage/usageAnalyticsContracts.js';
import type { InputFieldHint, InputOption } from './inputFields.js';
import { resolveUsageBucketBounds } from '../usage/usageCalendar.js';

export const UsageRelativePeriodSchema = z.enum(['today', '7days', '30days', '90days', 'year', 'all']);
export type UsageRelativePeriod = z.infer<typeof UsageRelativePeriodSchema>;

/** Personal usage input. Authority is captured by the host, never carried by the query. */
export const UsageQuerySchema = lazyZodSchema(() => {
  const clauses = UsageAnalyticsQueryRequestSchema.shape;
  const filters = UsageAnalyticsQueryFiltersSchema.shape;
  return z.object({
    period: z.union([clauses.dateRange.unwrap(), z.object({ relative: UsageRelativePeriodSchema,
      startMs: z.never().optional(), endMs: z.never().optional() }).strict()]).default({}),
    agents: filters.agentIds.unwrap().default([]),
    machines: filters.machineIds.unwrap().default([]),
    projects: filters.projectKeys.unwrap().default([]),
    sources: filters.sources.unwrap().default([]),
    session: z.union([filters.sessionIds.unwrap().element, filters.sessionIds.unwrap()]).nullable().default(null),
    costBasis: clauses.costMode.unwrap().default('auto'),
    metric: z.enum(['tokens', 'cost']).default('tokens'),
    // Host projection demand; accounting transport never receives this clause.
    includeSessionEvidence: z.boolean().default(true),
    includeWorkEvidence: z.boolean().default(true),
    breakdown: clauses.breakdowns.unwrap().default([]),
    modelIds: filters.modelIds.unwrap().default([]),
    workspaceIds: filters.workspaceIds.unwrap().default([]),
    backendModes: filters.backendModes.unwrap().default([]),
    ...UsageAnalyticsQueryRequestSchema.omit({ dateRange: true, costMode: true, breakdowns: true, filters: true }).shape,
  }).strict();
});
export type UsageQuery = z.infer<typeof UsageQuerySchema>;

/** Source inventory is metadata, independent of accounting period, metric and cost basis. */
export const UsageSourceInventoryScopeSchema = lazyZodSchema(() => UsageQuerySchema.pick({ agents: true, machines: true, sources: true }));
export type UsageSourceInventoryScope = z.infer<typeof UsageSourceInventoryScopeSchema>;

export const UsageQueryBatchInputSchema = lazyZodSchema(() => z.object({ queries: z.array(UsageQuerySchema).min(1) }).strict());
export type UsageQueryBatchInput = z.infer<typeof UsageQueryBatchInputSchema>;

const sortedSet = (values: readonly string[]) => [...new Set(values)].sort();

/** Canonical semantic identity includes every admitted filter and output clause. */
export function normalizeUsageQuery(value: unknown): UsageQuery {
  const query = UsageQuerySchema.parse(value);
  const sessions = query.session === null ? [] : typeof query.session === 'string' ? [query.session] : query.session;
  return { ...query,
    agents: sortedSet(query.agents), machines: sortedSet(query.machines), projects: sortedSet(query.projects),
    sources: sortedSet(query.sources), session: sessions.length ? sortedSet(sessions) : null,
    modelIds: sortedSet(query.modelIds), workspaceIds: sortedSet(query.workspaceIds), backendModes: sortedSet(query.backendModes),
    breakdown: [...new Set(query.breakdown)].sort(),
    includeInsights: query.includeInsights ?? false, includeActivity: query.includeActivity ?? false,
    includeLeaders: query.includeLeaders ?? false, includeModelTimeline: query.includeModelTimeline ?? false,
    includeMessageStats: query.includeMessageStats ?? false,
    ...(query.includeActivity ? { activityResolution: query.activityResolution ?? 'both' } : { activityResolution: undefined }),
  };
}

export function getUsageQueryKey(value: unknown): string {
  return createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(normalizeUsageQuery(value)));
}

/** A batch is a semantic set, not a source of result ordering or another query dialect. */
export function normalizeUsageQueryBatchInput(value: unknown): UsageQueryBatchInput {
  const input = UsageQueryBatchInputSchema.parse(value);
  const keyed = new Map(input.queries.map(candidate => {
    const query = normalizeUsageQuery(candidate);
    return [getUsageQueryKey(query), query] as const;
  }));
  return { queries: [...keyed].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, query]) => query) };
}

export function getUsageQueryBatchKey(value: unknown): string {
  return createCanonicalJsonSigningInput(projectNativeJsonValueForTransport(normalizeUsageQueryBatchInput(value)));
}

/** Resolve rolling intent only at the read boundary; persisted inputs and semantic keys stay relative. */
export function resolveUsageQueryPeriod(query: Pick<UsageQuery, 'period' | 'timeZoneOffsetMinutes'>, nowMs: number): NonNullable<UsageAnalyticsQueryRequest['dateRange']> {
  if (!('relative' in query.period)) return query.period;
  const relative = query.period.relative;
  const today = resolveUsageBucketBounds('day', nowMs, query.timeZoneOffsetMinutes).bucketStartMs;
  if (relative === 'today') return { startMs: today, endMs: nowMs };
  if (relative === 'all') return { startMs: 0, endMs: nowMs };
  const days = { '7days': 7, '30days': 30, '90days': 90, year: 365 }[relative];
  return { startMs: today - (days - 1) * 86_400_000, endMs: nowMs };
}

export function usageQueryToAnalyticsRequest(value: UsageQuery, nowMs = Date.now()): UsageAnalyticsQueryRequest {
  const query = normalizeUsageQuery(value);
  const { period: _period, agents, machines, projects, sources, session, costBasis, metric: _metric,
    includeSessionEvidence: _sessionEvidence, includeWorkEvidence: _workEvidence, breakdown,
    modelIds, workspaceIds, backendModes, ...clauses } = query;
  const selected = (values: string[]) => values.length ? values : undefined;
  return UsageAnalyticsQueryRequestSchema.parse({ ...clauses, dateRange: resolveUsageQueryPeriod(query, nowMs), costMode: costBasis, breakdowns: breakdown,
    filters: { agentIds: selected(agents), machineIds: selected(machines), projectKeys: selected(projects), sources: selected(sources),
      sessionIds: session === null ? undefined : typeof session === 'string' ? [session] : session,
      modelIds: selected(modelIds), workspaceIds: selected(workspaceIds), backendModes: selected(backendModes) },
  });
}

export function usageAnalyticsRequestToQuery(value: z.input<typeof UsageAnalyticsQueryRequestSchema>, presentation: Readonly<{ metric?: UsageQuery['metric'] }> = {}): UsageQuery {
  const { dateRange, filters, costMode, breakdowns, ...clauses } = UsageAnalyticsQueryRequestSchema.parse(value);
  return normalizeUsageQuery({ ...clauses, period: dateRange, agents: filters?.agentIds, machines: filters?.machineIds,
    projects: filters?.projectKeys, sources: filters?.sources, session: filters?.sessionIds ?? null,
    costBasis: costMode, breakdown: breakdowns, modelIds: filters?.modelIds, workspaceIds: filters?.workspaceIds,
    backendModes: filters?.backendModes, ...presentation });
}

const breakdownLabels = {
  agent: 'Agent', model: 'Model', session: 'Session', project: 'Project', workspace: 'Workspace',
  backendMode: 'Backend mode', source: 'Source', machine: 'Machine',
} satisfies Record<z.infer<typeof UsageAnalyticsBreakdownDimensionSchema>, string>;
const editableBreakdownDimensions = ['agent', 'model', 'project', 'source', 'machine'] as const satisfies readonly z.infer<typeof UsageAnalyticsBreakdownDimensionSchema>[];

/** Array-valued choices keep the UsageQuery contract, including existing multi-dimension pins. */
export function readUsageGroupByOptions(value: unknown): readonly InputOption[] {
  const options: InputOption[] = [{ value: [], label: 'Default' },
    ...editableBreakdownDimensions.map(dimension => ({ value: [dimension], label: breakdownLabels[dimension] }))];
  const stored = UsageQuerySchema.shape.breakdown.safeParse(value);
  if (stored.success && !options.some(option => JSON.stringify(option.value) === JSON.stringify(stored.data))) {
    options.push({ value: stored.data, label: stored.data.map(dimension => breakdownLabels[dimension]).join(' · ') });
  }
  return options;
}

/** The breakdowns widget really draws several dimensions; ordinary widgets choose one grouping. */
export const USAGE_MULTI_BREAKDOWN_INPUT_FIELD: InputFieldHint = {
  path: 'breakdown', title: 'Breakdown', widget: 'multiselect', contextMode: 'own', required: false,
  options: editableBreakdownDimensions.map(value => ({ value, label: breakdownLabels[value] })),
};

/** Same independently editable paths for widget, group and ordinary input editors. */
export const USAGE_QUERY_INPUT_FIELDS: readonly InputFieldHint[] = [
  { path: 'period', title: 'Period', widget: 'select', inputType: { hostType: 'usageQuery', field: 'period' }, contextMode: 'follow' },
  { path: 'agents', title: 'Agents', widget: 'multiselect', optionsSourceId: 'usage.filters.agents', placeholder: 'All agents', contextMode: 'follow', required: false },
  { path: 'machines', title: 'Machines', widget: 'multiselect', optionsSourceId: 'usage.filters.machines', placeholder: 'All machines', contextMode: 'follow', required: false },
  { path: 'projects', title: 'Projects', widget: 'multiselect', optionsSourceId: 'usage.filters.projects', placeholder: 'All projects', contextMode: 'follow', required: false },
  { path: 'sources', title: 'Sources', widget: 'multiselect', optionsSourceId: 'usage.filters.sources', placeholder: 'All sources', contextMode: 'follow', required: false },
  { path: 'session', title: 'Session', widget: 'select', inputType: { hostType: 'usageQuery', field: 'session' }, contextMode: 'follow', visibleWhenContextSlot: 'session' },
  { path: 'costBasis', title: 'Cost basis', widget: 'select', contextMode: 'follow',
    options: UsageAnalyticsQueryRequestSchema.shape.costMode.unwrap().options.map(value => ({ value,
      label: { auto: 'Automatic', reported: 'Reported', estimated: 'Estimated', api_equivalent: 'API equivalent' }[value] })) },
  { path: 'metric', title: 'Metric', widget: 'select', contextMode: 'own', options: [
    { value: 'tokens', label: 'Tokens' }, { value: 'cost', label: 'Cost' },
  ] },
  { path: 'breakdown', title: 'Group by', widget: 'select', contextMode: 'own', optionsSourceId: 'usage.query.breakdown' },
];
