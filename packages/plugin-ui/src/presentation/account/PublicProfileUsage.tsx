import type { BuiltinUsagePublicPresentationV1 } from '@happier-dev/plugin-sdk';

import { useHappierUiTheme } from '../../environment/context.js';
import { HappierText } from '../text/Text.js';
import type { PublicUsageChartModels } from '../usage/charts/publicUsageChartModels.js';
import type { UsageChartAgent, UsageChartPaint } from '../usage/charts/chartKit.js';
import type { UsagePlanetSlot } from '../usage/charts/usagePlanetSlot.js';
import { UsageSkyOfDays, type UsageSkyLabels } from '../usage/charts/UsageSkyOfDays.js';
import { UsageDaylight, UsageWeekTide, type UsageDaylightLabels, type UsageWeekTideLabels } from '../usage/charts/UsageRhythmEncodings.js';
import {
  UsageAgentRiver, UsageConstellation, UsageCrew, UsageOrbit, UsageShipped,
  type UsageConstellationLabels, type UsageCrewLabels, type UsageOrbitLabels, type UsageRiverLabels, type UsageShippedLabels,
} from '../usage/charts/UsageAgentsCharts.js';
import { UsagePlanetPortrait, UsageRunLength, type UsagePortraitLabels, type UsageRunLengthLabels } from '../usage/charts/UsageWorkCharts.js';

/** Host localization for the same chart bodies used by private Usage. */
export type HappierPublicProfileUsageLabels = Readonly<{
  chartLabel: (widgetId: BuiltinUsagePublicPresentationV1['widgetId']) => string;
  unavailable: string;
  sky?: UsageSkyLabels;
  weekTide?: UsageWeekTideLabels;
  daylight?: UsageDaylightLabels;
  orbit?: UsageOrbitLabels;
  crew?: UsageCrewLabels;
  river?: UsageRiverLabels;
  shipped?: UsageShippedLabels;
  constellation?: UsageConstellationLabels;
  planet?: UsagePortraitLabels;
  runLength?: UsageRunLengthLabels;
}>;

export type HappierPublicProfileUsageHost = Readonly<{
  paint: UsageChartPaint;
  agent: (agentId: string) => UsageChartAgent;
  renderPlanet?: UsagePlanetSlot;
  /** Cold render hosts supply the drawing width; interactive hosts may use the body's measurement. */
  width?: number;
  labels: HappierPublicProfileUsageLabels;
}>;

export type PublicProfileUsageBodyProps = Readonly<{
  presentation: BuiltinUsagePublicPresentationV1;
  /** Already projected by projectPublicProfile; this adapter has no policy or query authority. */
  models: PublicUsageChartModels;
  host: HappierPublicProfileUsageHost;
  testID: string;
}>;

/** A thin model/host adapter; shared Usage bodies own all chart markup and geometry. */
export function PublicProfileUsageBody({ presentation, models, host, testID }: PublicProfileUsageBodyProps) {
  const theme = useHappierUiTheme();
  const { labels } = host;
  const base = { theme, paint: host.paint, width: host.width, label: labels.chartLabel(presentation.widgetId), testID };
  const agents = (ids: readonly string[]) => [...new Set(ids)].map(host.agent);
  switch (presentation.widgetId) {
    case 'usage_rhythm':
      switch (presentation.inputs.style) {
        case 'sky':
          if (models.sky && labels.sky) return <UsageSkyOfDays {...base} model={models.sky} labels={labels.sky} agents={[]} />;
          break;
        case 'weekTide':
          if (models.weekHours && labels.weekTide) return <UsageWeekTide {...base} model={models.weekHours} labels={labels.weekTide} />;
          break;
        case 'daylight':
          if (models.daylight && labels.daylight) return <UsageDaylight {...base} model={models.daylight} labels={labels.daylight} />;
          break;
      }
      break;
    case 'usage_breakdowns':
      if (presentation.inputs.style === 'crew' && models.agentShares && labels.crew)
        return <UsageCrew {...base} model={models.agentShares} labels={labels.crew} agents={agents(models.agentShares.map(row => row.agentId))} />;
      break;
    case 'usage_orbit':
      if (models.agentShares && labels.orbit) return <UsageOrbit {...base} model={models.agentShares} labels={labels.orbit}
        agents={agents(models.agentShares.map(row => row.agentId))} renderPlanet={host.renderPlanet} />;
      break;
    case 'usage_flow':
      if (models.river && labels.river) return <UsageAgentRiver {...base} model={models.river} labels={labels.river}
        agents={agents(models.river.weeks.flatMap(week => Object.keys(week.shares)))} />;
      break;
    case 'usage_outcomes':
      if (presentation.inputs.style === 'shipped' && models.shipped && labels.shipped)
        return <UsageShipped {...base} model={models.shipped} labels={labels.shipped} agents={[]} />;
      break;
    case 'usage_constellation':
      if (models.constellation && labels.constellation) return <UsageConstellation {...base} model={models.constellation} labels={labels.constellation}
        agents={agents(models.constellation.nodes.map(row => row.agentId))} renderPlanet={host.renderPlanet} />;
      break;
    case 'usage_planet':
      if (labels.planet) return <UsagePlanetPortrait {...base} model={models.portrait} labels={labels.planet} renderPlanet={host.renderPlanet} />;
      break;
    case 'usage_run_length':
      if (models.runLength && labels.runLength) return <UsageRunLength {...base} model={models.runLength} labels={labels.runLength}
        agents={agents(models.runLength.rows.flatMap(row => row.agentId === null ? [] : [row.agentId]))} />;
      break;
  }
  return <HappierText variant="body" tone="secondary" testID={`${testID}-unavailable`}>{labels.unavailable}</HappierText>;
}
