import * as React from 'react';
import { View } from 'react-native';
import {
  UsageAgentRiver, UsageConstellation, UsageCrew, UsageDayInAgents, UsageDaylight, UsageOrbit, UsagePlanetPortrait, UsageRunLength,
  UsagePersonalRecords, UsageScore, UsageShipped, UsageSkyOfDays, UsageSteeringTide, UsageWeekTide,
} from '@happier-dev/plugin-ui/presentation';
import { resolveUsageDayStreaks } from '@happier-dev/protocol/usage/usageActivitySummary';
import { t } from '@/text';
import { formatUsageDuration } from './usageHowYouWorkPresentation';
import {
  UsageBodyInsufficient, UsageBodyReading, UsageCoverageLine, isUsageReadOutstanding, type UsageBodyProps,
} from './usageBodyKit';
import {
  formatUsageChartMetric, usageChartClock, usageChartDateLabels, usageChartMetricName, usageChartPercent, usageChartValuesLabels,
  usageChartWeekdays, useUsageChartHost, type UsageChartMetric,
} from './usageChartHost';
import {
  projectUsageAgentShares, projectUsageConstellationModel, projectUsageDayModel, projectUsageDaylight, projectUsageRiverModel,
  projectUsageRunLengthModel, projectUsageScoreModel, projectUsageShippedModel, projectUsageSkyModel, projectUsageSteeringModel,
  projectUsageRecordFacts, projectUsageWeekHours, resolveUsageChartDay, resolveUsageChartMetric,
} from './usageChartModels';

export type UsageChartStyleBodyProps = UsageBodyProps;

const HOW_YOU_WORK = ['how_you_work'] as const;
const LEVEL_NAMES = () => [t('usage.board.charts.levelNone'), t('usage.board.charts.levelQuiet'), t('usage.board.charts.levelSteady'),
  t('usage.board.charts.levelBusy'), t('usage.board.charts.levelBusiest')];

/** Reading, then "needs data" with its reason; one cause, one line. */
function UsageChartPending(props: Readonly<{ slice: UsageBodyProps['slice']; testID: string; title: string; reason: string }>) {
  if (isUsageReadOutstanding(props.slice, [...HOW_YOU_WORK, 'accounting']))
    return <UsageBodyReading testID={`${props.testID}.loading`} waitingOn={{ slice: props.slice, sources: [...HOW_YOU_WORK] }} />;
  return <UsageBodyInsufficient testID={`${props.testID}.needsData`} title={props.title} reason={props.reason} />;
}

function UsageChartFooter(props: Readonly<{ slice: UsageBodyProps['slice']; testID: string; onRetry: () => void }>) {
  return <UsageCoverageLine testID={`${props.testID}.coverage`} slice={props.slice} sources={[...HOW_YOU_WORK]} onRetry={props.onRetry} />;
}

function useCalendar(props: UsageBodyProps) {
  return props.slice.howYouWork?.agentCalendar ?? null;
}

/* ═════ Rhythm · Sky of days | Week tide | Daylight ═════ */

export function UsageSkyStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const metric = resolveUsageChartMetric(props.query.metric, 'busy');
  const colourBy = props.presentation?.colourBy === 'leadingAgent' ? 'leadingAgent' : 'intensity';
  const model = React.useMemo(() => calendar ? projectUsageSkyModel(calendar, metric, colourBy, Date.now()) : null, [calendar, metric, colourBy]);
  const agents = React.useMemo(() => {
    const ids = new Set<string>();
    for (const day of model?.days ?? []) {
      if (day.leader?.kind === 'agent') ids.add(day.leader.agentId);
      if (day.leader?.kind === 'tie') day.leader.agentIds.forEach((id) => ids.add(id));
    }
    return [...ids].map(host.agent);
  }, [model, host.agent]);
  if (!model) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  const dates = usageChartDateLabels(props.query);
  const metricName = usageChartMetricName(metric);
  return <View style={{ gap: 12 }} testID={`${props.testID}.sky`}>
    <UsageSkyOfDays theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.skyChart`}
      label={t('usage.board.charts.skyA11y', { metric: metricName, count: model.days.length })}
      labels={{
        formatValue: (value) => formatUsageChartMetric(metric, value), month: dates.month, day: dates.day,
        levels: { quiet: t('usage.board.charts.levelQuiet'), steady: t('usage.board.charts.levelSteady'), busy: t('usage.board.charts.levelBusy'), busiest: t('usage.board.charts.levelBusiest') },
        streakBestOngoing: (days) => t('usage.board.charts.streakBestOngoing', { count: days }),
        streakBest: (days) => t('usage.board.charts.streakBest', { count: days }),
        streakNow: (days) => t('usage.board.charts.streakNow', { count: days }),
        streakShort: (days, best) => best ? t('usage.board.charts.streakShortBest', { count: days }) : t('usage.board.charts.streakShort', { count: days }),
        key: { tie: t('usage.board.charts.tie'), notAttributed: t('usage.board.charts.notAttributed'), noActivity: t('usage.board.charts.noActivity'),
          notRecorded: t('usage.board.charts.notRecorded'), quieter: t('usage.board.charts.quieter'), busier: t('usage.board.charts.busier') },
        caption: colourBy === 'leadingAgent' ? t('usage.board.charts.skyCaptionAgent', { metric: metricName }) : t('usage.board.charts.skyCaptionIntensity'),
        values: { ...usageChartValuesLabels(), dateColumn: t('usage.board.charts.dateColumn'), valueColumn: metricName, leaderColumn: t('usage.board.charts.leaderColumn'),
          noActivity: t('usage.board.charts.noActivity'), notRecorded: t('usage.board.charts.notRecorded'), tie: t('usage.board.charts.tie'), notAttributed: t('usage.board.charts.notAttributed') },
      }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageWeekTideStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const metric = resolveUsageChartMetric(props.query.metric, 'busy');
  const model = React.useMemo(() => calendar ? projectUsageWeekHours(calendar, metric) : null, [calendar, metric]);
  if (!model) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.needsDataTitle')}
    reason={calendar ? t('usage.board.charts.metricNotByHourReason', { metric: usageChartMetricName(metric) }) : t('usage.board.charts.needsCalendarReason')} />;
  const weekdays = usageChartWeekdays();
  return <View style={{ gap: 12 }} testID={`${props.testID}.tide`}>
    <UsageWeekTide theme={host.theme} paint={host.paint} model={model} label={t('usage.board.charts.tideA11y', { metric: usageChartMetricName(metric) })} testID={`${props.testID}.tideChart`}
      labels={{ weekdays, clock: usageChartClock, peak: (weekday, hour, value) => t('usage.board.charts.tidePeak', { when: `${weekdays[weekday]} ${usageChartClock(hour)}`, value: formatUsageChartMetric(metric, value) }),
        values: { ...usageChartValuesLabels(), weekdayColumn: t('usage.board.charts.weekdayColumn'), formatValue: (value) => formatUsageChartMetric(metric, value), levelNames: LEVEL_NAMES() } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageDaylightStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const metric = resolveUsageChartMetric(props.query.metric, 'busy');
  const model = React.useMemo(() => calendar ? projectUsageDaylight(calendar, metric, props.slice) : null, [calendar, metric, props.slice]);
  if (!model) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.needsDataTitle')}
    reason={calendar ? t('usage.board.charts.metricNotByHourReason', { metric: usageChartMetricName(metric) }) : t('usage.board.charts.needsCalendarReason')} />;
  const window = (from: number, to: number) => `${usageChartClock(from)}–${usageChartClock(to)}`;
  return <View style={{ gap: 12 }} testID={`${props.testID}.daylight`}>
    <UsageDaylight theme={host.theme} paint={host.paint} model={model} label={t('usage.board.charts.daylightA11y', { metric: usageChartMetricName(metric) })} testID={`${props.testID}.daylightChart`}
      labels={{ clock: usageChartClock,
        night: (from, to, share) => share === null ? t('usage.board.charts.nightWindow', { window: window(from, to) }) : t('usage.board.charts.nightWindowShare', { window: window(from, to), share: usageChartPercent(share) }),
        caption: (peak, share) => share === null ? t('usage.board.charts.daylightCaption', { hour: usageChartClock(peak) }) : t('usage.board.charts.daylightCaptionNight', { hour: usageChartClock(peak), share: usageChartPercent(share) }),
        values: { ...usageChartValuesLabels(), hourColumn: t('usage.board.charts.hourColumn'), valueColumn: usageChartMetricName(metric), formatValue: (value) => formatUsageChartMetric(metric, value), levelNames: LEVEL_NAMES() } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

/* ═════ Parallel · Lanes | Dial ═════ */

export function UsageDayStyleBody(props: UsageChartStyleBodyProps & Readonly<{ style: 'lanes' | 'dial' }>) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const bucket = React.useMemo(() => calendar ? resolveUsageChartDay(calendar, props.presentation?.day) : null, [calendar, props.presentation?.day]);
  const model = React.useMemo(() => bucket ? projectUsageDayModel(props.slice, bucket) : null, [bucket, props.slice]);
  const agents = React.useMemo(() => (model?.lanes ?? []).flatMap(lane => lane.agentId === null ? [] : [host.agent(lane.agentId)]), [model, host.agent]);
  if (!model || model.lanes.length === 0) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.dayEmptyTitle')} reason={t('usage.board.charts.dayEmptyReason')} />;
  const dates = usageChartDateLabels(props.query);
  return <View style={{ gap: 12 }} testID={`${props.testID}.day`}>
    <UsageDayInAgents theme={host.theme} paint={host.paint} agents={agents} model={model} style={props.style} testID={`${props.testID}.dayChart`}
      label={t('usage.board.charts.dayA11y', { day: dates.day(model.date), count: model.peak.count })}
      labels={{ unknownAgent: t('usage.board.charts.unknownAgent'), clock: usageChartClock, duration: formatUsageDuration, atOnce: t('usage.board.charts.atOnce'), turns: t('usage.board.charts.turns'), agentTime: t('usage.board.charts.agentTime'),
        peak: (count, at) => t('usage.board.charts.peakAt', { count, time: usageChartClock(at) }), peakCount: (count) => t('usage.board.charts.atOnceCount', { count }),
        peakLine: (at, byAgent) => `${usageChartClock(at)} · ${byAgent.map((entry) => `${entry.name} ${entry.count}`).join(', ')}`,
        waiting: t('usage.board.charts.waitingForYou'), caption: { lanes: t('usage.board.charts.lanesCaption'), dial: t('usage.board.charts.dialCaption') },
        values: { ...usageChartValuesLabels(), agentColumn: t('usage.board.charts.agentColumn'), agentTimeColumn: t('usage.board.charts.agentTime'), spansColumn: t('usage.board.charts.spansColumn'),
          formatSpan: (from, to) => `${usageChartClock(from)}–${usageChartClock(to)}` } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

/* ═════ Agents: Score, Orbit, Crew, Agent river, Shipped, Constellation ═════ */

export function UsageScoreBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const model = React.useMemo(() => calendar ? projectUsageScoreModel(calendar, props.presentation?.day) : null, [calendar, props.presentation?.day]);
  const agents = React.useMemo(() => (model?.rows ?? []).map((row) => host.agent(row.agentId)), [model, host.agent]);
  if (!model) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  const dates = usageChartDateLabels(props.query);
  const start = Date.parse(`${model.weekStart}T12:00:00Z`);
  const dayDate = (index: number) => new Date(start + index * 86_400_000).toISOString().slice(0, 10);
  return <View style={{ gap: 12 }} testID={`${props.testID}.score`}>
    <UsageScore theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.scoreChart`}
      label={t('usage.board.charts.scoreA11y', { week: dates.short(model.weekStart) })}
      labels={{ day: (index) => dates.weekday(dayDate(index)), clock: usageChartClock,
        key: { light: t('usage.board.charts.scoreLight'), medium: t('usage.board.charts.scoreMedium'), strong: t('usage.board.charts.scoreStrong'),
          presence: t('usage.board.charts.scorePresence'), presenceNote: t('usage.board.charts.scorePresenceNote') },
        values: { ...usageChartValuesLabels(), agentColumn: t('usage.board.charts.agentColumn'), dayColumn: t('usage.board.charts.dateColumn'), hoursColumn: t('usage.board.charts.busyHoursColumn'),
          formatHours: (minutes) => minutes.flatMap((value, hour) => value ? [`${usageChartClock(hour)} ${t('usage.board.charts.minutes', { count: value })}`] : []).join(', ') } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

function useAgentShares(props: UsageChartStyleBodyProps, metric: UsageChartMetric) {
  const calendar = useCalendar(props);
  return React.useMemo(() => calendar ? projectUsageAgentShares(calendar, metric) : null, [calendar, metric]);
}

export function UsageOrbitBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const metric = resolveUsageChartMetric(props.query.metric, 'tokens');
  const shares = useAgentShares(props, metric);
  const agents = React.useMemo(() => (shares ?? []).map((share) => host.agent(share.agentId)), [shares, host.agent]);
  if (!shares || shares.length === 0) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.orbit`}>
    <UsageOrbit theme={host.theme} paint={host.paint} agents={agents} model={shares} renderPlanet={host.renderPlanet} testID={`${props.testID}.orbitChart`}
      label={t('usage.board.charts.orbitA11y', { metric: usageChartMetricName(metric) })}
      labels={{ percent: usageChartPercent, unknown: (names) => t('usage.board.charts.shareUnknown', { names }) }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageCrewBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const metric = resolveUsageChartMetric(props.query.metric, 'tokens');
  const shares = useAgentShares(props, metric);
  const agents = React.useMemo(() => (shares ?? []).map((share) => host.agent(share.agentId)), [shares, host.agent]);
  const model = React.useMemo(() => (shares ?? []).map((share) => ({ ...share,
    coverage: share.share === null ? { long: t('usage.board.charts.coverageContextOnly'), short: t('usage.board.charts.coverageContextOnlyShort') } : undefined })), [shares]);
  if (!shares || shares.length === 0) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  const activeDays = props.slice.howYouWork?.agentCalendar?.days.filter((day) => (day.totals.eventCount ?? 0) > 0).length ?? null;
  return <View style={{ gap: 12 }} testID={`${props.testID}.crew`}>
    <UsageCrew theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.crewChart`} label={t('usage.board.charts.crewA11y')}
      labels={{ percent: usageChartPercent, days: (days) => activeDays === null ? t('usage.board.charts.daysCount', { count: days }) : t('usage.board.charts.daysOf', { count: days, total: activeDays }) }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageRiverStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const metric = resolveUsageChartMetric(props.query.metric, 'tokens');
  const model = React.useMemo(() => calendar ? projectUsageRiverModel(calendar, metric) : null, [calendar, metric]);
  const agents = React.useMemo(() => [...new Set((model?.weeks ?? []).flatMap((week) => Object.keys(week.shares)))].map(host.agent), [model, host.agent]);
  if (!model) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.riverEmptyTitle')} reason={t('usage.board.charts.riverEmptyReason')} />;
  const dates = usageChartDateLabels(props.query);
  return <View style={{ gap: 12 }} testID={`${props.testID}.river`}>
    <UsageAgentRiver theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.riverChart`}
      label={t('usage.board.charts.riverA11y', { metric: usageChartMetricName(metric) })}
      labels={{ week: dates.short, inline: (name, share) => `${name} ${usageChartPercent(share)}`, caption: t('usage.board.charts.riverCaption'),
        values: { ...usageChartValuesLabels(), weekColumn: t('usage.board.charts.weekColumn'), totalColumn: usageChartMetricName(metric),
          formatTotal: (total) => formatUsageChartMetric(metric, total), percent: usageChartPercent } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageShippedStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const model = React.useMemo(() => projectUsageShippedModel(props.slice), [props.slice]);
  const agents = React.useMemo(() => [...new Set(model?.mode === 'weeks' ? model.weeks.flatMap((week) => week.spines.filter((spine) => spine !== 'mixed')) : [])].map(host.agent),
    [model, host.agent]);
  if (!model || model.total === 0) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.shippedEmptyTitle')} reason={t('usage.board.charts.shippedEmptyReason')} />;
  const dates = usageChartDateLabels(props.query);
  return <View style={{ gap: 12 }} testID={`${props.testID}.shipped`}>
    <UsageShipped theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.shippedChart`}
      label={t('usage.board.charts.shippedA11y', { count: model.total })}
      labels={{ week: dates.short, noDate: t('usage.board.charts.noDate'), countLine: (count) => t('usage.board.charts.shippedCount', { count }),
        mixed: t('usage.board.charts.mixed'), noMergeDate: t('usage.board.charts.noMergeDate'), colourBy: 'agent' }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageConstellationBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const shares = useAgentShares(props, 'tokens');
  const model = React.useMemo(() => projectUsageConstellationModel(props.slice, shares ?? []), [props.slice, shares]);
  const agents = React.useMemo(() => model.nodes.map((node) => host.agent(node.agentId)), [model, host.agent]);
  if (model.nodes.length === 0) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCollaborationReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.constellation`}>
    <UsageConstellation theme={host.theme} paint={host.paint} agents={agents} model={model} renderPlanet={host.renderPlanet} testID={`${props.testID}.constellationChart`}
      label={t('usage.board.charts.constellationA11y')}
      labels={{ kinds: { session: t('usage.board.charts.edgeSession'), run: t('usage.board.charts.edgeRun'), native: t('usage.board.charts.edgeNative') },
        arrowNote: t('usage.board.charts.edgeNote'), unknownStarts: (count) => t('usage.board.charts.unknownStarts', { count }), nodesOnly: t('usage.board.charts.nodesOnly') }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

/* ═════ How you work: Your planet, Steering by Agent, Run length ═════ */

export function UsagePlanetBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const calendar = useCalendar(props);
  const intervals = props.slice.howYouWork?.intervals ?? null;
  const model = React.useMemo(() => {
    if (!calendar) return null;
    const dates = calendar.days;
    const total = Math.max(1, Math.round((calendar.period.endMs - calendar.period.startMs) / 86_400_000));
    const streaks = resolveUsageDayStreaks({ referenceMs: Date.now(), timeZoneOffsetMinutes: calendar.timeZoneOffsetMinutes, range: calendar.period,
      days: dates.map((day) => ({ date: day.date, eventCount: day.totals.eventCount ?? 0 })) });
    return {
      ...(streaks.activeDays !== null ? { activeDays: { active: streaks.activeDays, of: total } } : {}),
      ...(intervals ? { peakParallel: intervals.maxParallel } : {}),
      ...(streaks.currentStreakDays !== null ? { streak: { current: streaks.currentStreakDays, best: streaks.longestStreakDays } } : {}),
    };
  }, [calendar, intervals]);
  if (!model) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.planet`}>
    <UsagePlanetPortrait theme={host.theme} paint={host.paint} model={model} renderPlanet={host.renderPlanet} testID={`${props.testID}.planetChart`} label={t('usage.board.charts.planetA11y')}
      labels={{ rows: { light: t('usage.board.charts.planetLight'), halo: t('usage.board.charts.planetHalo'), trail: t('usage.board.charts.planetTrail') },
        activeDays: (active, of) => t('usage.board.charts.daysOf', { count: active, total: of }), peak: (count) => t('usage.board.charts.upToAtOnce', { count }),
        streak: (days) => t('usage.board.charts.dayStreak', { count: days }), notShared: t('usage.board.charts.notRecorded'),
        lightNote: t('usage.board.charts.planetLightNote'), lightRest: t('usage.board.charts.planetLightRest'), haloNote: t('usage.board.charts.planetHaloNote'),
        haloRest: t('usage.board.charts.planetHaloRest'), trailNote: (best) => best === null ? t('usage.board.charts.planetTrailNoteNoBest') : t('usage.board.charts.planetTrailNote', { count: best }),
        trailRest: t('usage.board.charts.planetTrailRest') }} />
  </View>;
}

export function UsageSteeringStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const model = React.useMemo(() => projectUsageSteeringModel(props.slice), [props.slice]);
  const agents = React.useMemo(() => (model?.rows ?? []).flatMap((row) => row.agentId ? [host.agent(row.agentId)] : []), [model, host.agent]);
  if (!model || model.rows.length === 0) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.steeringEmptyTitle')} reason={t('usage.board.charts.steeringEmptyReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.steering`}>
    <UsageSteeringTide theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.steeringChart`} label={t('usage.board.charts.steeringA11y')}
      labels={{ clock: usageChartClock, unknownAgent: t('usage.board.charts.unknownAgent'), perBusyHourHeader: t('usage.board.charts.steersPerBusyHour'),
        fromPhoneHeader: t('usage.board.charts.fromPhone'), perBusyHourUnit: t('usage.board.charts.steersPerBusyHourUnit'), answers: t('usage.board.charts.answers'),
        rate: (value) => value === null ? '—' : (Math.round(value * 10) / 10).toString(),
        detail: (steers, busyMs) => t('usage.board.charts.steersDetail', { steers: steers ?? '—', busy: busyMs === null ? '—' : formatUsageDuration(busyMs) }),
        count: (value) => value === null ? '—' : String(value), caption: t('usage.board.charts.steeringCaption') }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

export function UsageRunLengthBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const model = React.useMemo(() => projectUsageRunLengthModel(props.slice), [props.slice]);
  const agents = React.useMemo(() => (model?.rows ?? []).flatMap((row) => row.agentId ? [host.agent(row.agentId)] : []), [model, host.agent]);
  if (!model) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.runEmptyTitle')} reason={t('usage.board.charts.runEmptyReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.runLength`}>
    <UsageRunLength theme={host.theme} paint={host.paint} agents={agents} model={model} testID={`${props.testID}.runLengthChart`} label={t('usage.board.charts.runA11y')}
      labels={{ duration: formatUsageDuration, unknownAgent: t('usage.board.charts.unknownAgent'),
        detail: (p90, samples) => t('usage.board.charts.runDetail', { p90: formatUsageDuration(p90), count: samples }),
        ticks: { minute: t('usage.board.charts.tickMinute'), tenMinutes: t('usage.board.charts.tickTenMinutes'), hour: t('usage.board.charts.tickHour'), fourHours: t('usage.board.charts.tickFourHours') },
        caption: model.openCount > 0 ? t('usage.board.charts.runCaptionOpen', { count: model.openCount }) : t('usage.board.charts.runCaption'),
        values: { ...usageChartValuesLabels(), agentColumn: t('usage.board.charts.agentColumn'), medianColumn: t('usage.board.charts.median'), p90Column: t('usage.board.charts.p90'),
          samplesColumn: t('usage.board.charts.closedTurns'), formatCount: (count) => count.toLocaleString() } }} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}

/* ═════ Recap · Personal records ═════ */

export function UsageRecordsStyleBody(props: UsageChartStyleBodyProps) {
  const host = useUsageChartHost(props.serverId);
  const metric = resolveUsageChartMetric(props.query.metric, 'tokens');
  const facts = React.useMemo(() => projectUsageRecordFacts(props.slice, metric, Date.now()), [props.slice, metric]);
  if (!facts) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  const dates = usageChartDateLabels(props.query);
  const agents = new Set((props.slice.howYouWork?.agentCalendar?.days ?? []).flatMap((day) => day.agents.flatMap((entry) => entry.agentId ? [entry.agentId] : [])));
  const records = [
    facts.longestStreak ? { id: 'streak', title: t('usage.board.charts.recordStreak'), value: t('usage.board.charts.daysCount', { count: facts.longestStreak.days }),
      detail: facts.longestStreak.ongoing ? t('usage.board.charts.recordRangeOngoing', { from: dates.short(facts.longestStreak.startDate), to: dates.short(facts.longestStreak.endDate) })
        : t('usage.board.charts.recordRange', { from: dates.short(facts.longestStreak.startDate), to: dates.short(facts.longestStreak.endDate) }) } : null,
    facts.busiestDay ? { id: 'busiest', title: t('usage.board.charts.recordBusiestDay'), value: formatUsageChartMetric(metric, facts.busiestDay.value),
      detail: `${usageChartMetricName(metric)} · ${dates.day(facts.busiestDay.date)}` } : null,
    facts.peakParallel ? { id: 'peak', title: t('usage.board.charts.recordPeak'), value: t('usage.board.charts.turnsCount', { count: facts.peakParallel.count }), detail: dates.day(facts.peakParallel.date) } : null,
    facts.longestClosedTurn ? { id: 'turn', title: t('usage.board.charts.recordLongestTurn'), value: formatUsageDuration(facts.longestClosedTurn.ms),
      detail: facts.longestClosedTurn.agentId ? host.agent(facts.longestClosedTurn.agentId).name : t('usage.board.charts.unknownAgent') } : null,
    facts.mostAgents ? { id: 'agents', title: t('usage.board.charts.recordMostAgents'), value: t('usage.board.charts.countOf', { count: facts.mostAgents.count, total: agents.size }),
      detail: dates.day(facts.mostAgents.date) } : null,
  ].filter((record): record is NonNullable<typeof record> => record !== null);
  if (records.length === 0) return <UsageChartPending slice={props.slice} testID={props.testID} title={t('usage.board.charts.needsDataTitle')} reason={t('usage.board.charts.needsCalendarReason')} />;
  return <View style={{ gap: 12 }} testID={`${props.testID}.records`}>
    <UsagePersonalRecords theme={host.theme} paint={host.paint} model={records} label={t('usage.board.charts.recordsA11y')} caption={t('usage.board.charts.recordsCaption')} testID={`${props.testID}.recordsList`} />
    <UsageChartFooter slice={props.slice} testID={props.testID} onRetry={props.model.refresh} />
  </View>;
}
