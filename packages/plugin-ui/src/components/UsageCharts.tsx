import type { ComponentProps } from 'react';
import * as Charts from '../presentation/usage/charts/index.js';
import { usePluginTheme } from './PluginUiProvider.js';

// These are theme adapters, not another chart implementation or widget registry. The caller supplies
// finite models, labels, identities and paint; private Usage and public profiles draw the same bodies.
export function UsageDailyChart(props: Omit<ComponentProps<typeof Charts.UsageDailyChart>, 'theme'>) {
  return <Charts.UsageDailyChart {...props} theme={usePluginTheme()} />;
}
export function UsageRhythmChart(props: Omit<ComponentProps<typeof Charts.UsageRhythmChart>, 'theme'>) {
  return <Charts.UsageRhythmChart {...props} theme={usePluginTheme()} />;
}
export function UsagePeriodSummaryBody(props: Omit<ComponentProps<typeof Charts.UsagePeriodSummaryBody>, 'theme'>) {
  return <Charts.UsagePeriodSummaryBody {...props} theme={usePluginTheme()} />;
}
export function UsageFootprintBody(props: Omit<ComponentProps<typeof Charts.UsageFootprintBody>, 'theme'>) {
  return <Charts.UsageFootprintBody {...props} theme={usePluginTheme()} />;
}
export function UsageSourceCoverageBody(props: Omit<ComponentProps<typeof Charts.UsageSourceCoverageBody>, 'theme'>) {
  return <Charts.UsageSourceCoverageBody {...props} theme={usePluginTheme()} />;
}
export function UsageBreakdownsBody(props: Omit<ComponentProps<typeof Charts.UsageBreakdownsBody>, 'theme'>) {
  return <Charts.UsageBreakdownsBody {...props} theme={usePluginTheme()} />;
}
export function UsageOutcomesBody(props: Omit<ComponentProps<typeof Charts.UsageOutcomesBody>, 'theme'>) {
  return <Charts.UsageOutcomesBody {...props} theme={usePluginTheme()} />;
}
export function UsageRecapBody(props: Omit<ComponentProps<typeof Charts.UsageRecapBody>, 'theme'>) {
  return <Charts.UsageRecapBody {...props} theme={usePluginTheme()} />;
}
export function UsageSkyOfDays(props: Omit<ComponentProps<typeof Charts.UsageSkyOfDays>, 'theme'>) {
  return <Charts.UsageSkyOfDays {...props} theme={usePluginTheme()} />;
}
export function UsageWeekTide(props: Omit<ComponentProps<typeof Charts.UsageWeekTide>, 'theme'>) {
  return <Charts.UsageWeekTide {...props} theme={usePluginTheme()} />;
}
export function UsageDaylight(props: Omit<ComponentProps<typeof Charts.UsageDaylight>, 'theme'>) {
  return <Charts.UsageDaylight {...props} theme={usePluginTheme()} />;
}
export function UsageDayInAgents(props: Omit<ComponentProps<typeof Charts.UsageDayInAgents>, 'theme'>) {
  return <Charts.UsageDayInAgents {...props} theme={usePluginTheme()} />;
}
export function UsageScore(props: Omit<ComponentProps<typeof Charts.UsageScore>, 'theme'>) {
  return <Charts.UsageScore {...props} theme={usePluginTheme()} />;
}
export function UsageOrbit(props: Omit<ComponentProps<typeof Charts.UsageOrbit>, 'theme'>) {
  return <Charts.UsageOrbit {...props} theme={usePluginTheme()} />;
}
export function UsageCrew(props: Omit<ComponentProps<typeof Charts.UsageCrew>, 'theme'>) {
  return <Charts.UsageCrew {...props} theme={usePluginTheme()} />;
}
export function UsageAgentRiver(props: Omit<ComponentProps<typeof Charts.UsageAgentRiver>, 'theme'>) {
  return <Charts.UsageAgentRiver {...props} theme={usePluginTheme()} />;
}
export function UsageShipped(props: Omit<ComponentProps<typeof Charts.UsageShipped>, 'theme'>) {
  return <Charts.UsageShipped {...props} theme={usePluginTheme()} />;
}
export function UsageConstellation(props: Omit<ComponentProps<typeof Charts.UsageConstellation>, 'theme'>) {
  return <Charts.UsageConstellation {...props} theme={usePluginTheme()} />;
}
export function UsagePlanetPortrait(props: Omit<ComponentProps<typeof Charts.UsagePlanetPortrait>, 'theme'>) {
  return <Charts.UsagePlanetPortrait {...props} theme={usePluginTheme()} />;
}
export function UsagePersonalRecords(props: Omit<ComponentProps<typeof Charts.UsagePersonalRecords>, 'theme'>) {
  return <Charts.UsagePersonalRecords {...props} theme={usePluginTheme()} />;
}
export function UsageSteeringTide(props: Omit<ComponentProps<typeof Charts.UsageSteeringTide>, 'theme'>) {
  return <Charts.UsageSteeringTide {...props} theme={usePluginTheme()} />;
}
export function UsageRunLength(props: Omit<ComponentProps<typeof Charts.UsageRunLength>, 'theme'>) {
  return <Charts.UsageRunLength {...props} theme={usePluginTheme()} />;
}
export function UsageNinetyPlanets(props: Omit<ComponentProps<typeof Charts.UsageNinetyPlanets>, 'theme'>) {
  return <Charts.UsageNinetyPlanets {...props} theme={usePluginTheme()} />;
}
export function UsageStreakThread(props: Omit<ComponentProps<typeof Charts.UsageStreakThread>, 'theme'>) {
  return <Charts.UsageStreakThread {...props} theme={usePluginTheme()} />;
}
export function UsageWeeksSkyline(props: Omit<ComponentProps<typeof Charts.UsageWeeksSkyline>, 'theme'>) {
  return <Charts.UsageWeeksSkyline {...props} theme={usePluginTheme()} />;
}
export function UsageAroundThePeriod(props: Omit<ComponentProps<typeof Charts.UsageAroundThePeriod>, 'theme'>) {
  return <Charts.UsageAroundThePeriod {...props} theme={usePluginTheme()} />;
}
export function UsageDaysOnSurface(props: Omit<ComponentProps<typeof Charts.UsageDaysOnSurface>, 'theme'>) {
  return <Charts.UsageDaysOnSurface {...props} theme={usePluginTheme()} />;
}
export function UsageRingedByStreaks(props: Omit<ComponentProps<typeof Charts.UsageRingedByStreaks>, 'theme'>) {
  return <Charts.UsageRingedByStreaks {...props} theme={usePluginTheme()} />;
}
export function UsageAgentMoons(props: Omit<ComponentProps<typeof Charts.UsageAgentMoons>, 'theme'>) {
  return <Charts.UsageAgentMoons {...props} theme={usePluginTheme()} />;
}
export function UsageMachines(props: Omit<ComponentProps<typeof Charts.UsageMachines>, 'theme'>) {
  return <Charts.UsageMachines {...props} theme={usePluginTheme()} />;
}
export function UsageProjects(props: Omit<ComponentProps<typeof Charts.UsageProjects>, 'theme'>) {
  return <Charts.UsageProjects {...props} theme={usePluginTheme()} />;
}
export function UsageAtmosphere(props: Omit<ComponentProps<typeof Charts.UsageAtmosphere>, 'theme'>) {
  return <Charts.UsageAtmosphere {...props} theme={usePluginTheme()} />;
}
export type {
  UsageSummaryMetric, UsageFootprintLabels, UsageSourceCoverageRow, UsageBreakdownBlock, UsageBreakdownsModel,
  UsageOutcomesModel, UsageRecapHighlight, UsageRecapModel,
  UsageChartAgent, UsageChartPaint, UsageChartValuesLabels, UsagePlanetSlot, UsagePlanetSpec,
  UsageSkyModel, UsageSkyDay, UsageSkyLeader, UsageSkyRun, UsageSkyLabels,
  UsageWeekHourModel, UsageWeekTideLabels, UsageDaylightModel, UsageDaylightLabels,
  UsageDayModel, UsageDayLabels, UsageScoreModel, UsageScoreLabels, UsageAgentShare,
  UsageOrbitLabels, UsageCrewLabels, UsageRiverModel, UsageRiverLabels, UsageShippedModel, UsageShippedLabels,
  UsageConstellationModel, UsageConstellationLabels, UsageCollaborationKind,
  UsagePortraitModel, UsagePortraitLabels, UsageRecordsModel, UsageSteeringTideModel, UsageSteeringTideLabels,
  UsageRunLengthModel, UsageRunLengthLabels,
  UsageCalendarArtModel, UsageCalendarLevel, UsageCalendarLabels, UsageSurfaceLabels, UsageRingsLabels,
  UsageMoonsModel, UsageMoonsLabels, UsageMachinesModel, UsageMachinesLabels, UsageProjectsModel, UsageProjectsLabels,
  UsageAtmosphereModel, UsageAtmosphereLabels,
} from '../presentation/usage/charts/index.js';
