import type { UsageCrewLabels, UsageOrbitLabels, UsagePortraitLabels, UsageShippedLabels, UsageSkyLabels } from '@happier-dev/plugin-ui/presentation';
import type { UsageQuery } from '@happier-dev/protocol/inputs/usageQuery';
import { t } from '@/text';
import { usageChartDateLabels, usageChartPercent, usageChartValuesLabels } from './usageChartHost';

/**
 * The app's wording for the shared chart bodies, built once for every consumer: private Usage
 * widgets and the owner's public profile preview read the same labels.
 */
export function usageSkyLabels(input: Readonly<{
  query: Pick<UsageQuery, 'timeZoneOffsetMinutes'>; metricName: string; formatValue: (value: number) => string;
  colourBy: 'intensity' | 'leadingAgent';
}>): UsageSkyLabels {
  const dates = usageChartDateLabels(input.query);
  return {
    formatValue: input.formatValue, month: dates.month, day: dates.day,
    levels: { quiet: t('usage.board.charts.levelQuiet'), steady: t('usage.board.charts.levelSteady'), busy: t('usage.board.charts.levelBusy'), busiest: t('usage.board.charts.levelBusiest') },
    streakBestOngoing: (days) => t('usage.board.charts.streakBestOngoing', { count: days }),
    streakBest: (days) => t('usage.board.charts.streakBest', { count: days }),
    streakNow: (days) => t('usage.board.charts.streakNow', { count: days }),
    streakShort: (days, best) => best ? t('usage.board.charts.streakShortBest', { count: days }) : t('usage.board.charts.streakShort', { count: days }),
    key: { tie: t('usage.board.charts.tie'), notAttributed: t('usage.board.charts.notAttributed'), noActivity: t('usage.board.charts.noActivity'),
      notRecorded: t('usage.board.charts.notRecorded'), quieter: t('usage.board.charts.quieter'), busier: t('usage.board.charts.busier') },
    caption: input.colourBy === 'leadingAgent' ? t('usage.board.charts.skyCaptionAgent', { metric: input.metricName }) : t('usage.board.charts.skyCaptionIntensity'),
    values: { ...usageChartValuesLabels(), dateColumn: t('usage.board.charts.dateColumn'), valueColumn: input.metricName, leaderColumn: t('usage.board.charts.leaderColumn'),
      noActivity: t('usage.board.charts.noActivity'), notRecorded: t('usage.board.charts.notRecorded'), tie: t('usage.board.charts.tie'), notAttributed: t('usage.board.charts.notAttributed') },
  };
}

export function usageOrbitLabels(): UsageOrbitLabels {
  return { percent: usageChartPercent, unknown: (names) => t('usage.board.charts.shareUnknown', { names }) };
}

/** `activeDays` is the period's active-day total when known; Agent days then read "12 of 40". */
export function usageCrewLabels(activeDays: number | null): UsageCrewLabels {
  return { percent: usageChartPercent,
    days: (days) => activeDays === null ? t('usage.board.charts.daysCount', { count: days }) : t('usage.board.charts.daysOf', { count: days, total: activeDays }) };
}

export function usagePlanetLabels(): UsagePortraitLabels {
  return { rows: { light: t('usage.board.charts.planetLight'), halo: t('usage.board.charts.planetHalo'), trail: t('usage.board.charts.planetTrail') },
    activeDays: (active, of) => t('usage.board.charts.daysOf', { count: active, total: of }), peak: (count) => t('usage.board.charts.upToAtOnce', { count }),
    streak: (days) => t('usage.board.charts.dayStreak', { count: days }), notShared: t('usage.board.charts.notRecorded'),
    lightNote: t('usage.board.charts.planetLightNote'), lightRest: t('usage.board.charts.planetLightRest'), haloNote: t('usage.board.charts.planetHaloNote'),
    haloRest: t('usage.board.charts.planetHaloRest'), trailNote: (best) => best === null ? t('usage.board.charts.planetTrailNoteNoBest') : t('usage.board.charts.planetTrailNote', { count: best }),
    trailRest: t('usage.board.charts.planetTrailRest') };
}

export function usageShippedLabels(query: Pick<UsageQuery, 'timeZoneOffsetMinutes'>, colourBy: UsageShippedLabels['colourBy']): UsageShippedLabels {
  const dates = usageChartDateLabels(query);
  return { week: dates.short, noDate: t('usage.board.charts.noDate'), countLine: (count) => t('usage.board.charts.shippedCount', { count }),
    mixed: t('usage.board.charts.mixed'), noMergeDate: t('usage.board.charts.noMergeDate'), colourBy };
}
