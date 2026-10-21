import type { ComponentProps } from 'react';
import * as Charts from '../presentation/usage/charts/index.js';
import { usePluginTheme } from './PluginUiProvider.js';

// These are theme adapters, not another chart implementation or widget registry. The caller supplies
// finite models, labels, identities and paint; private Usage and public profiles draw the same bodies.
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
export type {
  UsageChartAgent, UsageChartPaint, UsageChartValuesLabels, UsagePlanetSlot, UsagePlanetSpec,
  UsageSkyModel, UsageSkyDay, UsageSkyLeader, UsageSkyRun, UsageSkyLabels,
  UsageWeekHourModel, UsageWeekTideLabels, UsageDaylightModel, UsageDaylightLabels,
  UsageDayModel, UsageDayLabels, UsageScoreModel, UsageScoreLabels, UsageAgentShare,
  UsageOrbitLabels, UsageCrewLabels, UsageRiverModel, UsageRiverLabels, UsageShippedModel, UsageShippedLabels,
  UsageConstellationModel, UsageConstellationLabels, UsageCollaborationKind,
  UsagePortraitModel, UsagePortraitLabels, UsageRecordsModel, UsageSteeringTideModel, UsageSteeringTideLabels,
  UsageRunLengthModel, UsageRunLengthLabels,
} from '../presentation/usage/charts/index.js';
