import type { HappierPublicProfileUsageLabels } from '@happier-dev/plugin-ui/presentation';
import type { PublicProfileViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { resolveUsageCalendarDateStart } from '@happier-dev/protocol/usage/usageCalendar';
import { formatTokenCountLong, formatUsageCalendarDate, formatUsageChartClock,
    formatUsageDuration, formatUsageSharePercent } from '@happier-dev/protocol/usage/usageFormatting';
import { readBuiltinUsagePublicPresentationDescriptorV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { PUBLIC_PROFILE_LOCALE } from './publicProfileLabels';

/** Anonymous host wording for the shared bodies; only the already public view supplies its calendar. */
export function publicProfileUsageLabels(view: PublicProfileViewV1): HappierPublicProfileUsageLabels {
    const count = (value: number) => formatTokenCountLong(value, PUBLIC_PROFILE_LOCALE);
    const duration = (ms: number) => formatUsageDuration(ms, {
        seconds: seconds => `${count(seconds)} s`, minutes: minutes => `${count(minutes)} min`,
        hours: (hours, minutes) => `${count(hours)} h ${count(minutes)} min`,
    });
    const date = (value: string, options: Intl.DateTimeFormatOptions) => formatUsageCalendarDate(
        resolveUsageCalendarDateStart(value, view.snapshot.period.timeZoneOffsetMinutes),
        view.snapshot.period.timeZoneOffsetMinutes, options, PUBLIC_PROFILE_LOCALE);
    const shortDate = (value: string) => date(value, { day: 'numeric', month: 'short' });
    const weekday = (index: number) => formatUsageCalendarDate(Date.UTC(2024, 0, 1 + index), 0,
        { weekday: 'short' }, PUBLIC_PROFILE_LOCALE);
    const weekdays = [weekday(0), weekday(1), weekday(2), weekday(3), weekday(4), weekday(5), weekday(6)] as const;
    const levelNames = ['No activity', 'Quiet', 'Steady', 'Busy', 'Busiest'];
    const levelName = (value: number) => levelNames[value] ?? 'Not recorded';
    const values = { show: 'Show values', hide: 'Hide values' };
    const labels = {
        chartLabel: widgetId => readBuiltinUsagePublicPresentationDescriptorV1(widgetId)?.title ?? 'Public activity',
        unavailable: 'Not shared or not recorded',
        sky: {
            formatValue: levelName,
            month: value => date(value, { month: 'short' }),
            day: value => date(value, { weekday: 'short', day: 'numeric', month: 'short' }),
            levels: { quiet: 'Quiet', steady: 'Steady', busy: 'Busy', busiest: 'Busiest' },
            streakBestOngoing: days => `${count(days)}-day streak · best this period, still going`,
            streakBest: days => `Best · ${count(days)} days`, streakNow: days => `Now · ${count(days)} days`,
            streakShort: (days, best) => `${count(days)}-day streak${best ? ' · best' : ''}`,
            key: { tie: 'Tie', notAttributed: 'Not attributed', noActivity: 'No activity', notRecorded: 'Not recorded', quieter: 'Quieter', busier: 'Busier' },
            caption: 'Higher, larger and brighter marks stronger shared intensity. Faint lines join runs of five days or more; the soft band is the 7-day average.',
            values: { ...values, dateColumn: 'Day', valueColumn: 'Activity level', leaderColumn: 'Led by',
                noActivity: 'No activity', notRecorded: 'Not recorded', tie: 'Tie', notAttributed: 'Not attributed' },
        },
        weekTide: {
            weekdays, clock: formatUsageChartClock,
            peak: (day, hour, value) => `${weekdays[day] ?? ''} ${formatUsageChartClock(hour)} · ${levelName(value)}`,
            values: { ...values, weekdayColumn: 'Weekday', formatValue: levelName, levelNames },
        },
        daylight: {
            clock: formatUsageChartClock,
            night: (from, to, share) => `Night · ${formatUsageChartClock(from)}–${formatUsageChartClock(to)}${share === null ? '' : ` · ${formatUsageSharePercent(share)}`}`,
            // The public punch may be absent even when the night share is known; never invent a peak hour.
            caption: () => 'Each column is an hour of the day; taller marks stronger shared intensity.',
            values: { ...values, hourColumn: 'Hour', valueColumn: 'Activity level', formatValue: levelName, levelNames },
        },
        orbit: { percent: formatUsageSharePercent, unknown: names => `${names} · share unknown` },
        crew: { percent: formatUsageSharePercent, days: days => `${count(days)} days` },
        river: {
            week: shortDate, inline: (name, share) => `${name} ${formatUsageSharePercent(share)}`,
            caption: "Each week's shared agent mix. Equal widths do not imply weekly totals.",
            values: { ...values, weekColumn: 'Week', totalColumn: 'Total not shared', formatTotal: () => '—', percent: formatUsageSharePercent },
        },
        shipped: { week: shortDate, noDate: 'No date', countLine: total => `${count(total)} merged pull requests linked to agent work`,
            mixed: 'Mixed', noMergeDate: 'No merge date', colourBy: 'accent' },
        constellation: {
            kinds: { session: 'Started a session', run: 'Execution run · delegate, review, plan', native: 'Native subagents' },
            arrowNote: 'Arrow: who started → who did it · width: how often',
            unknownStarts: total => `${count(total)} sessions started by an agent we can't name`,
            nodesOnly: 'Collaboration details are not shared; each planet is an agent sized by its share.',
        },
        planet: {
            rows: { light: 'Light', halo: 'Halo', trail: 'Trail' },
            activeDays: (active, of) => `${count(active)} of ${count(of)} days`, peak: total => `Up to ${count(total)} at once`,
            streak: days => `${count(days)}-day streak`, notShared: 'Not shared or not recorded',
            lightNote: 'Grows with each active day in the period', lightRest: 'Rests at half light',
            haloNote: 'Widens with the most work run at once (of 8)', haloRest: 'No halo',
            trailNote: best => best === null ? 'Lengthens with each day of the current streak'
                : `Lengthens toward the best this period, ${count(best)} days`, trailRest: 'No trail',
        },
        runLength: {
            duration, unknownAgent: 'Unknown agent', detail: (p90, samples) => `p90 ${duration(p90)} · ${count(samples)}`,
            ticks: { minute: '1 min', tenMinutes: '10 min', hour: '1 h', fourHours: '4 h' },
            caption: 'One dot per shared duration observation. Bold is the median, thin is the 90th percentile.',
            values: { ...values, agentColumn: 'Agent', medianColumn: 'Median', p90Column: '90th percentile',
                samplesColumn: 'Observations', formatCount: count },
        },
    } satisfies Required<HappierPublicProfileUsageLabels>;
    return labels;
}
