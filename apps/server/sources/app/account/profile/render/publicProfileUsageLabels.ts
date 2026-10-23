import type { HappierPublicProfileUsageLabels } from '@happier-dev/plugin-ui/presentation';
import type { PublicProfileViewV1 } from '@happier-dev/protocol/account/publicProfilePublication';
import { resolveUsageCalendarDateStart, resolveUsageCalendarInstant } from '@happier-dev/protocol/usage/usageCalendar';
import { formatTokenCountLong, formatUsageCalendarDate, formatUsageChartClock,
    formatUsageDuration, formatUsageSharePercent } from '@happier-dev/protocol/usage/usageFormatting';
import { readBuiltinUsagePublicPresentationDescriptorV1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { PUBLIC_PROFILE_ASSET_LABELS, PUBLIC_PROFILE_LOCALE } from './publicProfileLabels';

/** Anonymous host wording for the shared bodies; only the already public view supplies its calendar. */
export function publicProfileUsageLabels(view: PublicProfileViewV1): HappierPublicProfileUsageLabels {
    const count = (value: number) => formatTokenCountLong(value, PUBLIC_PROFILE_LOCALE);
    const days = (value: number) => `${count(value)} ${value === 1 ? 'day' : 'days'}`;
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
    const recordTitles = { activeDays: 'Active days', currentStreakDays: 'Current streak', bestStreakDays: 'Best streak',
        peakParallel: 'Most at once', longestTurnMs: 'Longest closed turn' };
    const recordPeriod = PUBLIC_PROFILE_ASSET_LABELS.period(view.snapshot.period);
    const labels = {
        chartLabel: widgetId => readBuiltinUsagePublicPresentationDescriptorV1(widgetId)?.title ?? 'Public activity',
        unavailable: 'Not shared or not recorded',
        original: {
            metrics: { tokens: 'Tokens', activeDays: 'Active days', agentTimeMs: 'Agent time', mergedPrs: 'Merged pull requests',
                currentStreakDays: 'Current streak', bestStreakDays: 'Best streak in this period', peakParallel: 'Most at once' },
            formatMetric: (kind, value) => kind === 'agentTimeMs' ? duration(value) : count(value),
            activityLevel: 'Activity level', level: levelName, date: shortDate, weekdays, clock: formatUsageChartClock,
            showValues: values.show, hideValues: values.hide,
            agentMix: 'Agent mix', sourceSplit: 'Where they ran', percent: formatUsageSharePercent,
            source: execution => ({ happier: 'In Happier', outside: 'Outside Happier', unknown: 'Unknown' })[execution],
            coverage: { title: 'Coverage', columns: ['Source', 'Coverage'],
                status: status => ({ complete_for_supplied_facts: 'Complete for supplied facts', partial: 'Partial history', unknown: 'Unknown', unavailable: 'Unavailable' })[status],
                method: method => ({ runtime: 'Runtime', logs: 'Logs', context_only: 'Context only', mixed: 'Mixed sources', unknown: 'Unknown source' })[method] },
            footprint: { title: 'Insufficient basis', reason: 'There is no applicable versioned method for estimating energy or emissions.',
                noEstimate: 'No estimate', accounted: 'Accounted usage', tokensUnit: 'tokens', proxy: 'Proxy only',
                proxyDetail: 'Tokens are a proxy, not an energy measurement.', methodTitle: 'Method',
                methodBody: 'An estimate needs an applicable published method and sufficient model, serving, date and region evidence.' },
            period: recordPeriod,
        },
        sky: {
            formatValue: levelName,
            month: value => date(value, { month: 'short' }),
            day: value => date(value, { weekday: 'short', day: 'numeric', month: 'short' }),
            levels: { quiet: 'Quiet', steady: 'Steady', busy: 'Busy', busiest: 'Busiest' },
            streakBestOngoing: days => `${count(days)}-day streak · best this period, still going`,
            streakBest: value => `Best · ${days(value)}`, streakNow: value => `Now · ${days(value)}`,
            streakShort: (days, best) => `${count(days)}-day streak${best ? ' · best' : ''}`,
            key: { tie: 'Tie', notAttributed: 'Not attributed', noActivity: 'No activity', notRecorded: 'Not recorded', quieter: 'Quieter', busier: 'Busier' },
            caption: ({ runs, band }) => `Higher, larger and brighter marks stronger shared intensity.${runs && band ? ' Faint lines join runs of five days or more; the soft band is the 7-day average.'
                : runs ? ' Faint lines join runs of five days or more.' : band ? ' The soft band is the 7-day average.' : ''}`,
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
        parallel: {
            unknownAgent: 'Unknown agent',
            peakOnlyCaption: 'Most turns running at once in the period. A day, clock and agent timeline are not shared.',
            clock: formatUsageChartClock, duration, atOnce: 'At once', turns: 'turns', agentTime: 'Agent time',
            peak: (total, atHour) => `${count(total)} at once · ${formatUsageChartClock(atHour)}`,
            peakCount: total => `${count(total)} at once`,
            peakLine: (atHour, byAgent) => `${formatUsageChartClock(atHour)} · ${byAgent.map(entry => `${entry.name} ${count(entry.count)}`).join(', ')}`,
            waiting: 'Waiting for you',
            caption: {
                lanes: 'Each lane is an agent’s closed turns; hatched is waiting for you. The curve is turns running at once.',
                dial: 'Around the clock from 00 at the top. The filled shape is turns running at once; gaps are waits for you.',
            },
            values: { ...values, agentColumn: 'Agent', agentTimeColumn: 'Agent time', spansColumn: 'Worked',
                formatSpan: (from, to) => `${formatUsageChartClock(from)}–${formatUsageChartClock(to)}` },
        },
        orbit: { percent: formatUsageSharePercent, unknown: names => `${names} · share unknown`, unknownAgent: 'Unknown agent' },
        crew: { percent: formatUsageSharePercent, days, unknownAgent: 'Unknown agent' },
        river: {
            week: shortDate, inline: (name, share) => `${name} ${formatUsageSharePercent(share)}`,
            caption: "Each week's shared agent mix. Equal widths do not imply weekly totals.", unknownAgent: 'Unknown agent',
            partialWeek: (start, end) => `${shortDate(start)}–${shortDate(end)} · part week`,
            values: { ...values, weekColumn: 'Week', totalColumn: 'Total not shared', formatTotal: () => '—', percent: formatUsageSharePercent },
        },
        shipped: { week: shortDate, noDate: 'No date', countLine: total => `${count(total)} merged pull requests linked to agent work`,
            mixed: 'Mixed', noMergeDate: 'No merge date', colourBy: 'accent' },
        constellation: {
            kinds: { session: 'Started a session', run: 'Execution run · delegate, review, plan', native: 'Native subagents' },
            arrowNote: 'Arrow: who started → who did it · width: how often',
            unknownStarts: total => `${count(total)} sessions started by an agent we can't name`,
            nodesOnly: 'Collaboration details are not shared; each planet is an agent sized by its share.', unknownAgent: 'Unknown agent',
        },
        planet: {
            rows: { light: 'Light', halo: 'Halo', trail: 'Trail' },
            activeDays: (active, of) => `${count(active)} of ${count(of)} days`, peak: total => `Up to ${count(total)} at once`,
            streak: days => `${count(days)}-day streak`, notShared: 'Not shared or not recorded',
            lightNote: 'Grows with each active day in the period', lightRest: 'Rests at half light',
            haloNote: 'Widens with the most work run at once (of 8)', haloRest: 'No halo',
            trailNote: best => best === null ? 'Lengthens with each day of the current streak'
                : `Lengthens toward the best this period, ${days(best)}`, trailRest: 'No trail',
        },
        calendar: {
            month: value => date(value, { month: 'short' }), day: value => date(value, { weekday: 'short', day: 'numeric', month: 'short' }), short: shortDate,
            weekdayInitials: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
            levels: { quiet: 'Quiet', steady: 'Steady', busy: 'Busy', busiest: 'Busiest' }, noActivity: 'No activity', notRecorded: 'Not recorded',
            quieter: 'Quieter', busier: 'Busier', best: value => `Best · ${days(value)}`, now: value => `${days(value)} now`,
            ongoingBest: value => `${days(value)} · longest in this period`,
            lit: (active, days) => `${count(active)} of ${count(days)} days lit`, noRuns: 'No run of three days or more in this period',
            values: { ...values, dateColumn: 'Day', levelColumn: 'How busy', weekColumn: 'Week', activeDaysColumn: 'Active days' },
        },
        moons: {
            percent: formatUsageSharePercent, days: (active, of) => `${count(active)} of ${count(of)} days`, unknownAgent: 'Unknown agent',
            caption: daysShared => daysShared ? 'Each agent is a moon; its size is its share, the lit part how many days it worked.'
                : 'Each agent is a moon; its size is its share.',
            values: { ...values, agentColumn: 'Agent', shareColumn: 'Share', daysColumn: 'Days' },
        },
        machines: {
            kind: (kind, total) => `${kind === 'unknown' ? 'Unknown kind' : kind}${total > 1 ? ` ×${count(total)}` : ''}`, percent: formatUsageSharePercent,
            unavailable: 'Machine kinds are not recorded yet.', empty: 'No machine ran agents in this period.',
            values: { ...values, kindColumn: 'Machine', countColumn: 'How many', shareColumn: 'Share' },
        },
        projects: { empty: 'No public projects linked.' },
        atmosphere: {
            week: startMs => shortDate(resolveUsageCalendarInstant(startMs, view.snapshot.period.timeZoneOffsetMinutes).date),
            peak: total => `Up to ${count(total)} at once`, firstWeek: 'Week 1',
            caption: peak => peak === null ? 'The halo thickens in weeks with more agents at once; week 1 is at the top.'
                : `The halo thickens in weeks with more agents at once; up to ${count(peak)} at once this period.`,
            values: { ...values, weekColumn: 'Week', peakColumn: 'At once', notRecorded: 'Not recorded' },
        },
        runLength: {
            duration, unknownAgent: 'Unknown agent', detail: (p90, samples) => `p90 ${duration(p90)} · ${count(samples)}`,
            ticks: { minute: '1 min', tenMinutes: '10 min', hour: '1 h', fourHours: '4 h' },
            caption: "Each dot is an equal share of that agent's closed turns. Bold is the median, thin is the 90th percentile. Wall time from start to finish, permission waits included.",
            values: { ...values, agentColumn: 'Agent', medianColumn: 'Median', p90Column: '90th percentile',
                samplesColumn: 'Observations', formatCount: count },
        },
        records: {
            format: (kind, value) => ({ title: recordTitles[kind], detail: `Within the supplied period · ${recordPeriod}`,
                value: kind === 'longestTurnMs' ? duration(value) : kind === 'peakParallel' ? `${count(value)} at once` : days(value) }),
            caption: 'Shared records within the period shown.',
        },
    } satisfies Required<HappierPublicProfileUsageLabels>;
    return labels;
}
