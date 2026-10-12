import type { UsageAnalyticsBreakdownDimension, UsageAnalyticsBreakdownEntry, UsageAnalyticsContribution, UsageAnalyticsQueryResponse, UsageAnalyticsTimelineSource } from './usageAnalyticsContracts.js';
import { addUsageCostForMode, addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens, withEffectiveUsageCost } from './usageAggregation.js';
import { resolveEffectiveUsageCostUsd, resolveUsageContributionDimensionKey, type UsageCostMode } from './usageCostFacts.js';

export type UsageLeaderDimension = Parameters<typeof resolveUsageContributionDimensionKey>[1];
export type UsageLeaderContribution = Pick<UsageAnalyticsContribution,
    'sessionId' | 'agentId' | 'backendMode' | 'modelId' | 'projectKey' | 'workspaceId' | 'source' | 'tokens' | 'cost'>
    & Pick<UsageAnalyticsContribution, 'sourceContext'> & { machineId?: string | null; eventCount: number };
type UsageLeader = NonNullable<NonNullable<UsageAnalyticsQueryResponse['leaders']>['models']>[number];
type UsageRankedLeader = UsageLeader & { tokens: UsageLeaderContribution['tokens']; cost: UsageLeaderContribution['cost'] };

/** Server and private client reprojection rank the same complete candidate population. */
export function buildUsageLeaderList(rows: readonly UsageLeaderContribution[], dimension: UsageLeaderDimension, topLimit: number,
    mode: UsageCostMode, labels: ReadonlyMap<string, string | undefined> = new Map(), includeSources = false): UsageRankedLeader[] | undefined {
    const grouped = new Map<string, UsageRankedLeader>();
    const sourceGroups = new Map<string, Map<string, UsageAnalyticsTimelineSource>>();
    for (const row of rows) {
        const key = resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown';
        const existing = grouped.get(key) ?? { key, label: labels.get(key) ?? key, eventCount: 0,
            tokens: createEmptyUsageTokens(), cost: createEmptyUsageCost() };
        existing.eventCount += row.eventCount;
        existing.tokens = addUsageTokens(existing.tokens, row.tokens);
        existing.cost = addUsageCostForMode(existing.cost, row.cost, mode);
        if (includeSources) {
            const context = row.sourceContext ?? { path: 'unknown' as const, execution: 'unknown' as const };
            const source = row.source ?? 'unknown';
            const sourceKey = JSON.stringify([source, context.path, context.execution]);
            const parts = sourceGroups.get(key) ?? new Map<string, UsageAnalyticsTimelineSource>();
            const part = parts.get(sourceKey) ?? { ...context, source, eventCount: 0, tokens: createEmptyUsageTokens(), cost: createEmptyUsageCost() };
            parts.set(sourceKey, { ...part, eventCount: part.eventCount + row.eventCount,
                tokens: addUsageTokens(part.tokens, row.tokens), cost: addUsageCostForMode(part.cost, row.cost, mode) });
            sourceGroups.set(key, parts);
        }
        grouped.set(key, existing);
    }
    if (!grouped.size) return undefined;
    return [...grouped.values()].sort((left, right) => right.tokens.total - left.tokens.total
        || resolveEffectiveUsageCostUsd(right.cost, mode) - resolveEffectiveUsageCostUsd(left.cost, mode)
        || right.eventCount - left.eventCount || left.key.localeCompare(right.key))
        .slice(0, topLimit).map(leader => ({ ...leader, cost: withEffectiveUsageCost(leader.cost, mode),
            ...(includeSources ? { sources: [...sourceGroups.get(leader.key)!.entries()].sort(([left], [right]) => left.localeCompare(right))
                .map(([, part]) => ({ ...part, cost: withEffectiveUsageCost(part.cost, mode) })) } : {}) }));
}

/** Breakdown decoration retains the last witnessed context; ranking shares the leader owner. */
export function buildUsageBreakdownList(rows: readonly (UsageLeaderContribution & Pick<UsageAnalyticsContribution, 'context'>)[],
    dimension: UsageAnalyticsBreakdownDimension, topLimit: number, mode: UsageCostMode,
    previous: readonly UsageAnalyticsBreakdownEntry[] = []): UsageAnalyticsBreakdownEntry[] {
    const decorations = new Map<string, Pick<UsageAnalyticsBreakdownEntry, 'context' | 'latestContextUsedTokens' | 'latestContextWindowTokens'>>();
    for (const entry of previous) decorations.set(entry.key, { context: entry.context,
        latestContextUsedTokens: entry.latestContextUsedTokens, latestContextWindowTokens: entry.latestContextWindowTokens });
    for (const row of rows) {
        const key = resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown';
        const decoration = decorations.get(key) ?? {};
        if (row.context?.usedTokens != null || row.context?.windowTokens != null) decoration.context = row.context;
        if (dimension === 'session') {
            if (row.context?.usedTokens != null) decoration.latestContextUsedTokens = row.context.usedTokens;
            if (row.context?.windowTokens != null) decoration.latestContextWindowTokens = row.context.windowTokens;
        }
        decorations.set(key, decoration);
    }
    return (buildUsageLeaderList(rows, dimension, topLimit, mode, new Map(previous.map(entry => [entry.key, entry.label]))) ?? [])
        .map(leader => ({ ...leader, ...decorations.get(leader.key) }));
}

/** Older contributions lack witnessed counts; keep their candidates and mark ranking incomplete. */
export function reprojectUsageLeaders(value: UsageAnalyticsQueryResponse, contributions: readonly UsageAnalyticsContribution[], mode: UsageCostMode,
    projectCost: (raw: UsageLeaderContribution['cost'], rows: readonly UsageAnalyticsContribution[]) => UsageLeaderContribution['cost']):
    Pick<UsageAnalyticsQueryResponse, 'breakdowns' | 'leaders' | 'modelTimeline' | 'engineTimeline' | 'coverage'> {
    let incomplete = false;
    const project = (entries: UsageLeader[] | undefined, rows: readonly UsageAnalyticsContribution[], dimension: UsageLeaderDimension, includeSources = false) => {
        if (!entries) return undefined;
        if (rows.every(row => row.eventCount !== undefined)) {
            return buildUsageLeaderList(rows.map(row => ({ ...row, eventCount: row.eventCount! })), dimension, entries.length, mode,
                new Map(entries.map(entry => [entry.key, entry.label])), includeSources) ?? [];
        }
        incomplete = true;
        return entries.map(entry => {
            // Pre-count responses ranked raw model ids. Preserve that witnessed candidate
            // population until counts permit canonical regrouping; never invent counts.
            const selected = rows.filter(row => (dimension === 'model' ? row.modelId ?? 'unknown'
                : resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown') === entry.key);
            return { ...entry, ...(entry.cost ? { cost: projectCost(entry.cost, selected) } : {}) };
        });
    };
    const leaders = value.leaders && { ...value.leaders };
    const dimensions = { agents: 'agent', models: 'model', sessions: 'session', projects: 'project', workspaces: 'workspace', engines: 'engine' } as const;
    if (leaders) for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) leaders[key] = project(leaders[key], contributions, dimensions[key]);
    const timeline = (buckets: UsageAnalyticsQueryResponse['modelTimeline'], dimension: 'model' | 'engine') => buckets?.map(bucket => ({ ...bucket,
        leaders: project(bucket.leaders, contributions.filter(row => row.observedAtMs >= bucket.bucketStartMs && row.observedAtMs < bucket.bucketEndMs), dimension, true) ?? [] }));
    const modelTimeline = timeline(value.modelTimeline, 'model');
    const engineTimeline = timeline(value.engineTimeline, 'engine');
    const breakdowns = value.breakdowns && { ...value.breakdowns };
    if (breakdowns) for (const dimension of Object.keys(breakdowns) as UsageAnalyticsBreakdownDimension[]) {
        const entries = breakdowns[dimension];
        if (!entries) continue;
        if (contributions.every(row => row.eventCount !== undefined)) {
            breakdowns[dimension] = buildUsageBreakdownList(contributions.map(row => ({ ...row, eventCount: row.eventCount! })),
                dimension, entries.length, mode, entries);
        } else {
            incomplete = true;
            breakdowns[dimension] = entries.map(entry => ({ ...entry, cost: projectCost(entry.cost,
                contributions.filter(row => (dimension === 'model' ? row.modelId ?? 'unknown'
                    : resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown') === entry.key)) }));
        }
    }
    const fullPopulation = contributions.every(row => row.eventCount !== undefined)
        && contributions.reduce((sum, row) => sum + (row.eventCount ?? 0), 0) === value.totals.eventCount;
    const ranked = value.coverage?.ranked.map(entry => {
        const returned = breakdowns?.[entry.dimension];
        if (!fullPopulation || !returned) return entry;
        const totalEntries = new Set(contributions.map(row => resolveUsageContributionDimensionKey(row, entry.dimension) ?? 'unknown')).size;
        return { ...entry, totalEntries, returnedEntries: returned.length, complete: totalEntries === returned.length };
    });
    const coverage = incomplete && value.coverage ? { ...value.coverage,
        status: value.coverage.status === 'complete' ? 'partial' as const : value.coverage.status,
        reasons: [...new Set([...value.coverage.reasons, 'ranked_truncation' as const])],
        ranked: value.coverage.ranked.map(entry => ({ ...entry, complete: false })),
    } : value.coverage && { ...value.coverage, ranked: ranked ?? value.coverage.ranked };
    return { breakdowns, leaders, modelTimeline, engineTimeline, coverage };
}
