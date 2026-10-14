import type { UsageAnalyticsBreakdownDimension } from './usageAnalyticsContracts.js';
import type { UsageQueryResultSlice } from './resolveUsagePageAggregation.js';

export type UsageScopeFilterField = 'sources' | 'agents' | 'machines' | 'projects';
const dimensionOf: Readonly<Record<UsageScopeFilterField, UsageAnalyticsBreakdownDimension>> = {
  sources: 'source', agents: 'agent', machines: 'machine', projects: 'project',
};

/** Engine timeline keys carry the Agent id before an optional backend mode. */
export function agentIdFromEngineKey(key: string): string {
  const separator = key.indexOf(':');
  return separator === -1 ? key : key.slice(0, separator);
}

/** Both ordinary inputs and the Usage toolbar consume the admitted accounting inventory. */
export function readUsageScopeOptions(slices: readonly UsageQueryResultSlice[], field: UsageScopeFilterField,
  selected: readonly string[] = []): Map<string, string> {
  const labels = new Map<string, string>();
  for (const slice of slices) {
    if (field === 'agents') for (const bucket of slice.accounting?.engineTimeline ?? []) for (const entry of bucket.leaders) {
      const agentId = agentIdFromEngineKey(entry.key);
      if (!labels.has(agentId)) labels.set(agentId, agentId);
    }
    for (const entry of slice.accounting?.breakdowns?.[dimensionOf[field]] ?? []) {
      labels.set(entry.key, entry.label ?? labels.get(entry.key) ?? entry.key);
    }
    if (field === 'sources') for (const source of slice.accounting?.coverage?.sources ?? []) {
      if (!labels.has(source.source)) labels.set(source.source, source.source);
    }
    if (field === 'machines') for (const source of slice.accounting?.coverage?.sources ?? []) {
      if (source.machineId && !labels.has(source.machineId)) labels.set(source.machineId, source.machineId);
    }
  }
  for (const value of selected) if (!labels.has(value)) labels.set(value, value);
  return labels;
}
