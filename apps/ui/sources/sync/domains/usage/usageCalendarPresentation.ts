import { resolveUsageBucketBounds, resolveUsageCalendarDateStart } from '@happier-dev/protocol/usage/usageCalendar';
import { type UsageAnalyticsCoverage, type UsageAnalyticsGranularity, type UsageAnalyticsQueryResponse } from '@happier-dev/protocol';
import { resolveUsageQueryPeriod, type UsageQuery, type UsageRelativePeriod } from '@happier-dev/protocol/inputs/usageQuery';
import { getUsagePeriodDefinition } from '@/sync/api/account/usagePeriods';
import { formatWithCachedDateTimeFormatter } from '@/utils/datetime/cachedIntlFormatters';
import { getPreferredLanguage, t } from '@/text';
import { formatUsageCalendarDate as formatSharedUsageCalendarDate, formatUsageCalendarRange }
    from '@happier-dev/protocol/usage/usageFormatting';

/** Shared presentation semantics from the admitted query: fixed offsets and exclusive ends. */
export type UsageCalendarRange = Readonly<{
    startMs?: number;
    endMs: number;
    granularity: UsageAnalyticsGranularity;
    timeZoneOffsetMinutes: number;
}>;

/** An open range is drawn only as far as the producer witnessed it, never up to the viewer's clock. */
export function resolveUsageShownCalendarRange(query: UsageQuery, coverage?: UsageAnalyticsCoverage,
    accounting?: UsageAnalyticsQueryResponse): UsageCalendarRange | null {
    // Older open-ended responses already witness their last observation/day. Source freshness
    // can be older than those observations and the viewer clock cannot extend retained facts.
    let firstObserved: number | undefined;
    let witnessedEnd: number | undefined;
    const witness = (startMs: number, endMs: number) => {
        firstObserved = firstObserved === undefined ? startMs : Math.min(firstObserved, startMs);
        witnessedEnd = witnessedEnd === undefined ? endMs : Math.max(witnessedEnd, endMs);
    };
    for (const row of accounting?.contributions ?? []) witness(row.observedAtMs, row.observedAtMs + 1);
    // Full bucket bounds are only a fallback for older readers without observation timestamps.
    if (witnessedEnd === undefined) {
        for (const bucket of accounting?.series ?? []) witness(bucket.bucketStartMs, bucket.bucketEndMs);
        for (const day of accounting?.activity?.calendarDays ?? []) {
            const startMs = resolveUsageCalendarDateStart(day.date, query.timeZoneOffsetMinutes);
            witness(startMs, startMs + 86_400_000);
        }
    }
    const endMs = query.period.endMs ?? coverage?.range.endMs ?? witnessedEnd;
    if (endMs === undefined) return null;
    const relativeName = 'relative' in query.period ? query.period.relative : undefined;
    const relative = relativeName !== undefined ? resolveUsageQueryPeriod(query, endMs - 1) : null;
    // All time shows retained history; an explicitly pinned epoch start stays exact.
    const startMs = relativeName === 'all' ? firstObserved
        : relative?.startMs ?? query.period.startMs ?? coverage?.range.startMs;
    return { ...(startMs !== undefined ? { startMs } : {}), endMs,
        granularity: query.granularity, timeZoneOffsetMinutes: query.timeZoneOffsetMinutes };
}

/** Missing counts are zero only where the producer proves complete accounting for that interval. */
export function usageMissingBucketValue(startMs: number, range: UsageCalendarRange, coverage?: UsageAnalyticsCoverage): 0 | null {
    if (coverage?.range.complete !== true) return null;
    const endMs = resolveUsageBucketBounds(range.granularity, startMs, range.timeZoneOffsetMinutes).bucketEndMs;
    const countedStart = Math.max(startMs, range.startMs ?? startMs);
    const countedEnd = Math.min(endMs, range.endMs);
    return countedStart < countedEnd && coverage.range.startMs !== undefined && coverage.range.endMs !== undefined
        && coverage.range.startMs <= countedStart && coverage.range.endMs >= countedEnd ? 0 : null;
}

export function formatUsageCalendarDate(timestampMs: number, timeZoneOffsetMinutes: number,
    options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' },
    locales?: Intl.LocalesArgument): string {
    return formatSharedUsageCalendarDate(timestampMs, timeZoneOffsetMinutes, options, locales ?? getPreferredLanguage(), formatWithCachedDateTimeFormatter);
}

/** Observation clocks use the viewer's local calendar, not the queried accounting bucket offset. */
export function formatUsageObservedAt(timestampMs: number, nowMs = Date.now(), locales?: Intl.LocalesArgument): string {
    const observed = new Date(timestampMs);
    const now = new Date(nowMs);
    const today = observed.getFullYear() === now.getFullYear() && observed.getMonth() === now.getMonth() && observed.getDate() === now.getDate();
    return formatWithCachedDateTimeFormatter(timestampMs, locales ?? getPreferredLanguage(), { hour: 'numeric', minute: '2-digit',
        ...(!today ? { year: 'numeric', month: 'short', day: 'numeric' } as const : {}) });
}

/** Exact selected dates; a named rolling preset cannot be recovered from a range's duration. */
export function formatUsageCalendarPeriod(period: Readonly<{ relative?: UsageRelativePeriod; startMs?: number; endMs?: number; timeZoneOffsetMinutes?: number }>,
    locales?: Intl.LocalesArgument): string {
    if (period.relative !== undefined) return t(getUsagePeriodDefinition(period.relative).translationKey);
    const offset = period.timeZoneOffsetMinutes ?? 0;
    if (period.startMs === undefined) return period.endMs === undefined ? t('usage.allTime')
        : `${t('usage.allTime')} – ${formatUsageCalendarDate(period.endMs - 1, offset, undefined, locales)}`;
    if (period.endMs === undefined) return `${formatUsageCalendarDate(period.startMs, offset, undefined, locales)} – ${t('usage.today')}`;
    return formatUsageCalendarRange(period.startMs, period.endMs, offset, locales ?? getPreferredLanguage(), formatWithCachedDateTimeFormatter);
}
