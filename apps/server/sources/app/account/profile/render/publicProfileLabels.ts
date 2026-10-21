import { formatTokenCount, formatTokenCountLong, formatUsageCalendarDate, formatUsageCalendarRange,
    formatUsageDurationCompact, formatUsageUtcOffset } from '@happier-dev/protocol/usage/usageFormatting';
import type { PublicProfileViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import type { HappierPublicProfileLabels } from '@happier-dev/plugin-ui/presentation';
import type { PublicProfileAssetLabels, PublicProfileAssetMetric } from './publicProfileSvg';

/** Anonymous delivery has one explicit default locale, independent of the server OS. */
export const PUBLIC_PROFILE_LOCALE = 'en-US';
export const PUBLIC_PROFILE_STATE_LABELS = { paused: 'Profile paused', unavailable: 'Profile unavailable' } as const;
const metricLabels: Record<PublicProfileAssetMetric, string> = {
    tokens: 'tokens', 'agent-time': 'agent time', 'merged-prs': 'merged PRs', streak: 'day streak',
    'peak-parallel': 'peak parallel', 'active-days': 'active days',
};
export const PUBLIC_PROFILE_ASSET_LABELS: PublicProfileAssetLabels = {
    brand: 'Happier', ...PUBLIC_PROFILE_STATE_LABELS, empty: 'Public profile',
    period: period => `${formatUsageCalendarRange(period.startMs, period.endMs, period.timeZoneOffsetMinutes, PUBLIC_PROFILE_LOCALE)} · ${formatUsageUtcOffset(period.timeZoneOffsetMinutes)}`,
    synced: computedAtMs => `Synced ${formatUsageCalendarDate(computedAtMs, 0, { year: 'numeric', month: 'short', day: 'numeric', timeZoneName: 'short' }, PUBLIC_PROFILE_LOCALE)}`,
    metricLabel: metric => metricLabels[metric],
    formatMetric: (metric, value) => metric === 'agent-time' ? formatUsageDurationCompact(value, PUBLIC_PROFILE_LOCALE)
        : metric === 'tokens' ? formatTokenCount(value) : formatTokenCountLong(value, PUBLIC_PROFILE_LOCALE),
};

export function publicProfilePageLabels(view: PublicProfileViewV1): HappierPublicProfileLabels {
    const since = view.identity.sinceMs === undefined ? '' : ` · since ${formatUsageCalendarDate(view.identity.sinceMs,
        view.snapshot.period.timeZoneOffsetMinutes, { month: 'long', year: 'numeric' }, PUBLIC_PROFILE_LOCALE)}`;
    return { identityLine: `@${view.handle} · ${view.service.displayName}${since}`, periodTitle: 'Public activity',
        periodDetail: `${PUBLIC_PROFILE_ASSET_LABELS.period(view.snapshot.period)} · ${PUBLIC_PROFILE_ASSET_LABELS.synced(view.snapshot.computedAtMs)}`,
        emptyLayout: 'No public blocks placed.', footerNote: 'Shared by this person. Private activity stays private.',
        report: 'Report this profile', madeWith: 'Made with Happier',
        inert: { success: 'Success', warning: 'Warning', error: 'Error', incomplete: 'Incomplete' } };
}
