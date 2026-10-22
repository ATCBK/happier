import * as React from 'react';
import type { MachinePublishedResourceSummaryV1 } from '@happier-dev/protocol/machines/resources/machineResourceSummaryV1';
import type { MachineVitalsHistoryV1 } from '@happier-dev/protocol/machines/vitals/machineVitalsHistoryV1';

import { readMachinePublishedResources } from '@/components/machines/summary/machineResourceSentences';
import {
  buildMachineVitalsTimeline,
  selectMachineVitalsOverviewView,
  type MachineVitalsOverviewView,
  type MachineVitalsTimeline,
} from '@/components/machines/vitals/machineVitalsPresentation';
import { resolveVitalsAxis } from '@/components/machines/vitals/vitalsFormat';
import type { MachineVitalsRange } from '@/sync/domains/machines/resources/machineRpc';
import { useMachineVitalsOverview } from '@/sync/domains/machines/resources/useMachineVitalsOverview';

import type {
  MachineWidgetMachineFacts,
  MachineWidgetTarget,
} from './machineWidgetKit';

export type MachineWidgetVitalsView = Readonly<{
  view: MachineVitalsOverviewView;
  published: MachinePublishedResourceSummaryV1 | null;
  timeline: MachineVitalsTimeline | null;
  axis: readonly [string, string];
  today: MachineVitalsHistoryV1['today'] | null;
  retry: () => void;
}>;

/**
 * The Overview's own reading for a widget: plan 20's `useMachineVitalsOverview` (a mounted widget is demand
 * on its watch, released when it unmounts or goes offscreen) projected by the Overview's own selectors.
 * Nothing is fetched or derived here that the Overview tab does not derive the same way.
 */
export function useMachineWidgetVitalsView(
  input: Readonly<{
    target: MachineWidgetTarget;
    facts: MachineWidgetMachineFacts;
    range: MachineVitalsRange;
    enabled?: boolean;
  }>,
): MachineWidgetVitalsView {
  const overview = useMachineVitalsOverview({
    serverId: input.target.serverId,
    machineId: input.target.machineId,
    daemonStateVersion: input.facts.daemonStateVersion,
    range: input.range,
    enabled: input.enabled !== false && input.facts.online === true,
  });
  const daemonState: unknown = input.facts.machine?.daemonState;
  const published = React.useMemo(
    () => readMachinePublishedResources(daemonState),
    [daemonState],
  );
  const view = selectMachineVitalsOverviewView({
    online: input.facts.online,
    published,
    state: overview,
  });
  const timeline = React.useMemo(
    () =>
      buildMachineVitalsTimeline({
        range: input.range,
        history: overview.history,
        samples: overview.samples,
      }),
    [input.range, overview.history, overview.samples],
  );
  const axis = resolveVitalsAxis(
    input.range,
    timeline,
    view.kind === 'ready' && view.freshness === 'live',
  );
  return {
    view,
    published,
    timeline,
    axis,
    today: overview.history?.today ?? null,
    retry: overview.retry,
  };
}
