import * as React from 'react';

import { useThisComputerMachineId } from '@/components/machines/add/useMachineAddPaths';
import { WidgetArea } from '@/components/widgets/area/WidgetArea';
import { WidgetAreaPresetLine } from '@/components/widgets/area/WidgetAreaPresetLine';
import {
  useWidgetAreaLayout,
  type WidgetAreaPort,
} from '@/components/widgets/area/useWidgetAreaLayout';
import type { WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { collectMachineAttention } from '@/components/machines/attention/collectMachineAttention';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

import { selectMachinesPresetMachine, type MachinesWidgetPresetMachine } from './machinesWidgetPresets';
import { useMachinesWidgetAreaBinding } from './useMachinesWidgetAreaBinding';

/**
 * The All machines dashboard (lab `rw` D, Dp; AGW-19): the person's own widget area under the page sentence —
 * "Overview · Your layout · only you see it" with the platform's one Add/Customize, the shared frame and its
 * Reset/Undo line when edited. Its default is the static preset; every edit is the platform's layout owner.
 */
export function MachinesDashboardArea(props: Readonly<{
  /** The fleet as the page lists it (its first online machine, its first machine): binds the preset's group. */
  fleet: Readonly<{ firstOnline: MachinesWidgetPresetMachine | null; first: MachinesWidgetPresetMachine | null; onlineKeys: readonly string[]; presenceLoaded: boolean }>;
  /** The same visible Homes and attention census that the page presents. */
  attention: Pick<ReturnType<typeof collectMachineAttention>, 'entries' | 'reportingMachineKeys'>;
}>) {
  const language = usePreferredLanguage();
  const viewer = useActiveServerAccountScope();
  const { serverId } = useActiveServerSnapshot();
  const thisComputer = useThisComputerMachineId();
  const pinnedMachine = React.useMemo(
    () => selectMachinesPresetMachine({
      serverId: serverId ?? null,
      presenceLoaded: props.fleet.presenceLoaded,
      needsYou: props.attention.entries.filter(entry => entry.attention.level === 'needs_you'),
      thisComputerMachineId: thisComputer ?? null,
      reportingMachineKeys: props.attention.reportingMachineKeys,
      fleet: props.fleet,
    }),
    [props.attention, props.fleet, serverId, thisComputer],
  );
  const names = React.useMemo(
    () => ({
      overview: t('machines.widgets.body.presets.overview'),
      machineHealth: t('machines.widgets.body.presets.machineHealth'),
    }),
    [language],
  );
  const binding = useMachinesWidgetAreaBinding({
    serverId: viewer?.serverId ?? '',
    names,
    pinnedMachine,
  });
  if (!binding.port) {
    return (
      <WidgetArea
        port={null}
        context={binding.context}
        geometry="grid"
        title={names.overview}
        meta={t('machines.widgets.body.presets.yourLayout')}
        surfaceName={t('machines.widgets.body.presets.surfaceName')}
        testID="machines.dashboard"
      />
    );
  }
  return (
    <MachinesDashboardDocument
      port={binding.port}
      context={binding.context}
      binding={binding}
      title={names.overview}
    />
  );
}

function MachinesDashboardDocument(
  props: Readonly<{
    port: WidgetAreaPort;
    context: WidgetSurfaceContext;
    binding: ReturnType<typeof useMachinesWidgetAreaBinding>;
    title: string;
  }>,
) {
  const layout = useWidgetAreaLayout(props.port, props.context);
  const ready = layout.state.status === 'ready' ? layout.state : null;
  return (
    <>
      {ready?.preset?.isEdited ? (
        <WidgetAreaPresetLine
          preset={ready.preset}
          surface={ready.surface}
          presetActions={props.binding}
          testID="machines.dashboard.preset"
        />
      ) : null}
      <WidgetArea
        port={props.port}
        context={props.context}
        layout={layout}
        geometry="grid"
        title={props.title}
        meta={t('machines.widgets.body.presets.yourLayout')}
        surfaceName={t('machines.widgets.body.presets.surfaceName')}
        testID="machines.dashboard"
      />
    </>
  );
}
