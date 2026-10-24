import type { UsageAnalyticsBreakdownDimension, UsageAnalyticsBreakdownEntry, UsageAnalyticsBreakdowns, UsageAnalyticsQueryRequest, UsageAnalyticsQueryResponse, UsageAnalyticsSeriesBucket, UsageAnalyticsTotals, UsageObservationContext } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { inTx, type Tx } from "@/storage/inTx";
import {
    buildUsageActivity,
    buildUsageEngineTimeline,
    buildUsageInsights,
    buildUsageLeaders,
    buildUsageModelTimeline,
    deriveEngineKey,
} from "./query/buildUsagePremiumSections";
import { buildUsageBreakdownList } from '@happier-dev/protocol/usage/usageLeaderProjection';
import { resolveUsageBucketBounds as resolveBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { resolveUsageContributionDimensionKey } from '@happier-dev/protocol/usage/usageCostFacts';
import { resolveUsageTokenCategories } from '@happier-dev/protocol/usage/usageTokenCategories';
import { repriceUsageObservationCost, repriceUsageAnalyticsResponse } from '@happier-dev/protocol/usage/usageCost';
import { captureUsageModelPriceCatalogInTx, resolveCapturedUsageModelPriceCatalog, type CapturedUsageModelPriceCatalog } from './usageModelPriceCatalog';
import { loadUsageMessageCountsBySessionInTx } from "./query/loadUsageMessageStatsForQuery";
import {
    resolveScopedUsageContributions,
    resolveUsageContributionSourceContext,
    usageAccountingSubjectKey,
    type ScopedUsageContribution,
    type ScopedUsageEventRow,
} from "./query/resolveScopedUsageContributions";
import { isPublicEligibleUsageRow, readScopedUsageAccountingEvidence, toScopedUsageEventRow } from "./query/scopedUsageEventRow";
import { addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens, normalizeLegacyUsageCost, normalizeLegacyUsageTokens } from "./usageMetrics";
import { addUsageCostForMode, resolveUsageCostMode, withEffectiveUsageCost, type UsageCostMode } from "./query/resolveUsageCostMode";
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from "./usageSourceClassifier";
import { buildUsageResultProjection } from "./query/buildUsageResultProjection";
import { LegacyUsageReportDataSchema, legacyUsageReportCanonicalOrder, readLegacyUsageReportKey } from "./legacyUsageReportSchema";
import { canonicalUsageModelPriceId } from "@happier-dev/protocol/usage/usageModelPriceCatalog";
import { aggregateUsageContributionCosts } from '@happier-dev/protocol/usage/usageAggregation';

function toPremiumEventRow(row: ScopedUsageContribution) {
    return row;
}

function readContributionContext(row: ScopedUsageContribution): UsageObservationContext | undefined {
    if (row.contextUsedTokens == null && row.contextWindowTokens == null) return undefined;
    return {
        usedTokens: row.contextUsedTokens,
        windowTokens: row.contextWindowTokens,
    };
}

function resolveLatestContributionContext(
    rows: readonly ScopedUsageContribution[],
): UsageObservationContext | undefined {
    let latest: UsageObservationContext | undefined;
    for (const row of rows) {
        latest = readContributionContext(row) ?? latest;
    }
    return latest;
}

function toUsageTotals(rows: ScopedUsageContribution[], costMode: UsageCostMode): UsageAnalyticsTotals {
    let tokens = createEmptyUsageTokens();
    const eventIds = new Set<string>();

    for (const row of rows) {
        tokens = addUsageTokens(tokens, row.tokens);
        for (const eventId of row.contributingEventIds) eventIds.add(eventId);
    }
    const cost = aggregateUsageContributionCosts(rows, costMode);

    return {
        eventCount: eventIds.size,
        tokens,
        cost: withEffectiveUsageCost(cost, costMode),
        context: resolveLatestContributionContext(rows),
    };
}

function buildSeries(
    rows: ScopedUsageContribution[],
    granularity: UsageAnalyticsQueryRequest['granularity'],
    timeZoneOffsetMinutes: number,
    costMode: UsageCostMode,
): UsageAnalyticsSeriesBucket[] {
    const buckets = new Map<number, UsageAnalyticsSeriesBucket>();

    for (const row of rows) {
        const { bucketStartMs, bucketEndMs } = resolveBucketBounds(
            granularity,
            row.observedAt.getTime(),
            timeZoneOffsetMinutes,
        );
        const current = buckets.get(bucketStartMs) ?? {
            bucketStartMs,
            bucketEndMs,
            eventCount: 0,
            tokens: createEmptyUsageTokens(),
            cost: createEmptyUsageCost(),
        };
        current.eventCount += row.contributingEventIds.length;
        current.tokens = addUsageTokens(current.tokens, row.tokens);
        current.cost = addUsageCostForMode(current.cost, row.cost, costMode);
        current.context = readContributionContext(row) ?? current.context;
        buckets.set(bucketStartMs, current);
    }

    return Array.from(buckets.values()).sort((left, right) => left.bucketStartMs - right.bucketStartMs);
}

function buildBreakdownEntries(
    rows: ScopedUsageContribution[],
    dimension: UsageAnalyticsBreakdownDimension,
    topLimit: number,
    costMode: UsageCostMode,
): UsageAnalyticsBreakdownEntry[] {
    return buildUsageBreakdownList(rows.map(row => ({ ...row, eventCount: row.contributingEventIds.length,
        context: { usedTokens: row.contextUsedTokens, windowTokens: row.contextWindowTokens } })), dimension, topLimit, costMode);
}

async function loadUsageEventsForQuery(tx: Tx, accountId: string, request: UsageAnalyticsQueryRequest) {
    return await tx.usageEvent.findMany({
        where: {
            accountId,
            // A range start or Session/dimension/source filter cannot remove
            // baselines or an overlapping producer before reconciliation.
            observedAt: request.dateRange?.endMs !== undefined
                ? { lt: new Date(request.dateRange.endMs) }
                : undefined,
            source: {
                notIn: [...TEAM_CREDENTIAL_ONLY_USAGE_SOURCES],
            },
        },
        orderBy: {
            observedAt: 'asc',
        },
        select: {
            id: true,
            sessionId: true,
            observedAt: true,
            createdAt: true,
            agentId: true,
            backendMode: true,
            modelId: true,
            projectKey: true,
            workspaceId: true,
            machineId: true,
            source: true,
            scope: true,
            isCumulative: true,
            turnId: true,
            externalKey: true,
            metadata: true,
            requestCount: true,
            teamCredentialResourceId: true,
            teamCredentialActorAccountId: true,
            teamCredentialExternalApiKeyId: true,
            teamCredentialSourceCredentialId: true,
            brokerMachineId: true,
            credentialDeliveryMode: true,
            inputTokens: true,
            outputTokens: true,
            reasoningTokens: true,
            cacheReadTokens: true,
            cacheWriteTokens: true,
            totalTokens: true,
            reportedCostUsd: true,
            estimatedCostUsd: true,
            invoiceCostUsd: true,
            billingContext: true,
            costSource: true,
            currency: true,
            costBreakdown: true,
            contextUsedTokens: true,
            contextWindowTokens: true,
        },
    });
}

function matchesUsageFilters(row: ScopedUsageContribution, filters: UsageAnalyticsQueryRequest['filters']): boolean {
    const matches = (values: readonly string[] | undefined, value: string | null | undefined) => (
        !values?.length || values.includes(value ?? 'unknown')
    );
    return matches(filters?.sessionIds, row.sessionId)
        && matches(filters?.agentIds, row.agentId)
        && (!filters?.modelIds?.length || filters.modelIds.some(id =>
            (canonicalUsageModelPriceId(id) ?? 'unknown') === (resolveUsageContributionDimensionKey(row, 'model') ?? 'unknown')))
        && matches(filters?.projectKeys, row.projectKey)
        && matches(filters?.workspaceIds, row.workspaceId)
        && matches(filters?.machineIds, row.machineId)
        && matches(filters?.backendModes, row.backendMode)
        && matches(filters?.sources, row.source)
        && (filters?.execution === undefined || resolveUsageContributionSourceContext(row).execution === filters.execution);
}

async function loadRetainedLegacyUsageReports(
    tx: Tx, accountId: string, request: UsageAnalyticsQueryRequest,
) {
    return await tx.usageReport.findMany({ where: {
        accountId,
        sessionId: request.filters?.sessionIds?.length ? { in: request.filters.sessionIds } : undefined,
        updatedAt: request.dateRange?.endMs !== undefined ? { lt: new Date(request.dateRange.endMs) } : undefined,
    }, orderBy: legacyUsageReportCanonicalOrder,
    select: { id: true, sessionId: true, key: true, data: true, createdAt: true, updatedAt: true } });
}

function resolveRetainedLegacyUsageRows(
    reports: UsageAnalyticsSnapshot['legacyReports'],
    bridgedRows: UsageAnalyticsSnapshot['rows'],
): ScopedUsageEventRow[] {
    const bridged = new Set(bridgedRows.filter((row) => row.source === 'legacy_usage_report')
        .map((row) => JSON.stringify([row.sessionId, readLegacyUsageReportKey(row.metadata)])));
    const retainedKeys = new Set<string>();
    return reports.flatMap((report): ScopedUsageEventRow[] => {
        const key = JSON.stringify([report.sessionId, report.key]);
        if (retainedKeys.has(key)) return [];
        retainedKeys.add(key);
        if (bridged.has(key)) return [];
        const parsed = LegacyUsageReportDataSchema.safeParse(report.data);
        if (!parsed.success) return [];
        return [{
            id: `legacy-report:${report.id}`, sessionId: report.sessionId,
            observedAt: report.updatedAt, createdAt: report.createdAt,
            agentId: 'legacy', backendMode: null, modelId: null, projectKey: null, workspaceId: null,
            machineId: null, source: 'legacy_usage_report', scope: 'turn_delta', isCumulative: false,
            turnId: null, contextUsedTokens: null, contextWindowTokens: null,
            tokens: normalizeLegacyUsageTokens(parsed.data.tokens), cost: normalizeLegacyUsageCost(parsed.data.cost),
            metadata: { usageAccounting: { path: 'legacy', status: 'unknown', historyComplete: false,
                asOfMs: report.updatedAt.getTime() } },
        }];
    });
}

export async function queryUsageAnalytics(
    accountId: string,
    request: UsageAnalyticsQueryRequest,
): Promise<UsageAnalyticsQueryResponse> {
    const snapshot = await inTx(tx => captureUsageAnalyticsInTx(tx, accountId, request), { /* Usage events, retained reports and transcript attribution share one analytics snapshot. */ isolationLevel: "Serializable", readOnly: true });
    return projectUsageAnalytics(snapshot, request);
}

export interface UsageAnalyticsSnapshot {
    rows: Awaited<ReturnType<typeof loadUsageEventsForQuery>>;
    legacyReports: Awaited<ReturnType<typeof loadRetainedLegacyUsageReports>>;
    priceCatalog: CapturedUsageModelPriceCatalog;
    messageCountsBySession: ReadonlyMap<string, number> | undefined;
}

/** Ownership admission and every DB reader share the caller's transaction. No result computation or reply runs here. */
export async function captureUsageAnalyticsInTx(
    tx: Tx,
    accountId: string,
    request: UsageAnalyticsQueryRequest,
): Promise<UsageAnalyticsSnapshot> {
    const rows = await loadUsageEventsForQuery(tx, accountId, request);
    const legacyReports = await loadRetainedLegacyUsageReports(tx, accountId, request);
    const priceCatalog = await captureUsageModelPriceCatalogInTx(tx);
    // Reconciliation may exclude candidates. Capture their counts now and sum
    // only the selected Sessions after commit, preserving publication ceilings.
    let messageCountsBySession: ReadonlyMap<string, number> | undefined;
    if (request.population !== 'public_eligible_personal' && request.filters?.execution === undefined
        && (request.includeMessageStats || request.includeInsights)) {
        const sessionIds = new Set<string>();
        for (const row of rows) if (row.sessionId) sessionIds.add(row.sessionId);
        for (const report of legacyReports) if (report.sessionId) sessionIds.add(report.sessionId);
        messageCountsBySession = await loadUsageMessageCountsBySessionInTx(tx, accountId, request, [...sessionIds]);
    }
    return { rows, legacyReports, priceCatalog, messageCountsBySession };
}

/** Reconcile, price and aggregate only committed captured rows, without retaining a pooled connection. */
export function projectUsageAnalytics(snapshot: UsageAnalyticsSnapshot, request: UsageAnalyticsQueryRequest): UsageAnalyticsQueryResponse {
    const scopedRows = [...snapshot.rows.map(toScopedUsageEventRow), ...resolveRetainedLegacyUsageRows(snapshot.legacyReports, snapshot.rows)
        .map((row) => ({ ...row, accountingEvidence: readScopedUsageAccountingEvidence(row) }))];
    const resolved = resolveScopedUsageContributions(scopedRows, request.dateRange);
    // Keep every counter baseline until reconciliation has established the
    // individual requests. Excluding raw rows first would manufacture residuals.
    const publicPopulation = request.population === 'public_eligible_personal';
    const population = publicPopulation ? resolved.totalContributions.filter(isPublicEligibleUsageRow) : resolved.totalContributions;
    const costMode = resolveUsageCostMode(request.costMode);
    const priceCatalog = resolveCapturedUsageModelPriceCatalog(snapshot.priceCatalog);
    const totalContributions = population.filter((row) => matchesUsageFilters(row, request.filters)).map((row) => ({
        ...row, cost: repriceUsageObservationCost(row.cost, row.modelId,
            resolveUsageTokenCategories(row.tokens, readScopedUsageAccountingEvidence(row).accounting), priceCatalog, {}, costMode),
    }));
    const bucketAttributions = totalContributions;
    const premiumRows = totalContributions.map(toPremiumEventRow);
    const premiumBucketRows = bucketAttributions.map(toPremiumEventRow);
    const totals = toUsageTotals(totalContributions, costMode);
    const sessionIds = Array.from(
        new Set(
            premiumRows.flatMap((row) => (row.sessionId ? [row.sessionId] : [])),
        ),
    );
    // Whole-Session counts cannot prove membership in a selected execution population.
    const capturedMessageCounts = publicPopulation || request.filters?.execution !== undefined ? undefined : snapshot.messageCountsBySession;
    const messageCounts = capturedMessageCounts
        ? { messageCount: sessionIds.reduce((count, sessionId) => count + (capturedMessageCounts.get(sessionId) ?? 0), 0) }
        : undefined;
    const insights = messageCounts
        ? buildUsageInsights(premiumRows, messageCounts, request.timeZoneOffsetMinutes)
        : undefined;
    const messageStats = insights && messageCounts
        ? {
            sessionCount: insights.sessionsUsed,
            messageCount: messageCounts.messageCount,
        }
        : undefined;
    const breakdowns = request.breakdowns?.length
        ? request.breakdowns.reduce<UsageAnalyticsBreakdowns>((acc, dimension) => {
            acc[dimension] = buildBreakdownEntries(totalContributions, dimension, request.topLimit, costMode);
            return acc;
        }, {})
        : undefined;
    let evidenceRows = scopedRows;
    if (publicPopulation || request.filters?.execution !== undefined) {
        const selectedEventIds = new Set(totalContributions.flatMap(row => row.contributingEventIds));
        evidenceRows = scopedRows.filter(row => selectedEventIds.has(row.id) && (!publicPopulation || isPublicEligibleUsageRow(row)));
    } else {
        const selectedSubjects = new Set(totalContributions.map(usageAccountingSubjectKey));
        evidenceRows = scopedRows.filter((row) => selectedSubjects.has(usageAccountingSubjectKey(row))
            || matchesUsageFilters({ ...row, contributingEventIds: [row.id] }, request.filters));
    }
    const rankedDimensions = new Set(request.breakdowns ?? []);
    if (request.includeLeaders) for (const dimension of ['agent', 'model', 'session', 'project', 'workspace', 'backendMode'] as const) rankedDimensions.add(dimension);
    const modelTimeline = request.includeModelTimeline ? buildUsageModelTimeline(premiumBucketRows,
        request.granularity, request.topLimit, request.timeZoneOffsetMinutes, request.costMode) : undefined;
    const engineTimeline = request.includeModelTimeline ? buildUsageEngineTimeline(premiumBucketRows,
        request.granularity, request.topLimit, request.timeZoneOffsetMinutes, request.costMode) : undefined;
    const timelineCardinalities = new Map<number, { models: Set<string>; engines: Set<string> }>();
    if (request.includeModelTimeline) for (const row of totalContributions) {
        const { bucketStartMs } = resolveBucketBounds(request.granularity, row.observedAt.getTime(), request.timeZoneOffsetMinutes);
        const counts = timelineCardinalities.get(bucketStartMs) ?? { models: new Set<string>(), engines: new Set<string>() };
        counts.models.add(resolveUsageContributionDimensionKey(row, 'model') ?? 'unknown');
        counts.engines.add(deriveEngineKey(row) ?? 'unknown');
        timelineCardinalities.set(bucketStartMs, counts);
    }
    const truncatedTimeline = [...timelineCardinalities.values()].some((counts) => counts.models.size > request.topLimit || counts.engines.size > request.topLimit);
    const ranked = [...rankedDimensions].map((dimension) => {
        const totalEntries = new Set(totalContributions.map((row) => resolveUsageContributionDimensionKey(row, dimension) ?? 'unknown')).size;
        const returnedEntries = Math.min(totalEntries, request.topLimit);
        return { dimension, totalEntries, returnedEntries, complete: totalEntries === returnedEntries };
    });
    if (modelTimeline && !rankedDimensions.has('model')) {
        ranked.push({ dimension: 'model',
            totalEntries: new Set(totalContributions.map((row) => resolveUsageContributionDimensionKey(row, 'model') ?? 'unknown')).size,
            returnedEntries: new Set(modelTimeline.flatMap((bucket) => bucket.leaders.map((leader) => leader.key))).size,
            complete: [...timelineCardinalities.values()].every((counts) => counts.models.size <= request.topLimit),
        });
    }
    const projection = buildUsageResultProjection({
        contributions: totalContributions, evidenceRows,
        coverageReasons: [...totalContributions.flatMap((row) => row.coverageReasons ?? []),
            ...(truncatedTimeline ? ['ranked_truncation' as const] : [])], request, ranked,
    });
    if (!projection.costPresentation) {
        const { effectiveUsd: _selected, ...rawCost } = totals.cost;
        totals.cost = rawCost;
    }

    return repriceUsageAnalyticsResponse({
        v: 1,
        totals,
        series: request.includeSeries
            ? buildSeries(bucketAttributions, request.granularity, request.timeZoneOffsetMinutes, costMode)
            : undefined,
        breakdowns,
        insights: request.includeInsights ? insights : undefined,
        activity: request.includeActivity
            ? buildUsageActivity(premiumRows, request.activityResolution, request.timeZoneOffsetMinutes)
            : undefined,
        leaders: request.includeLeaders ? buildUsageLeaders(premiumRows, request.topLimit, request.costMode) : undefined,
        modelTimeline,
        engineTimeline,
        messageStats,
        ...projection,
    }, priceCatalog, {}, costMode);
}
