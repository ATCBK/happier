import {
  instantiateWidgetLayoutFragmentGroupV1,
  type WidgetAreaPresetV1,
  type WidgetInputBindingsV1,
  type WidgetLayoutItemV1,
  type WidgetSizeV1,
} from '@happier-dev/protocol/widgets';
import type { MachineBuiltinWidgetIdV1 } from '@happier-dev/protocol/widgets';

export const MACHINES_WIDGET_PRESET_IDS = ['overview'] as const;
export type MachinesWidgetPresetId =
  (typeof MACHINES_WIDGET_PRESET_IDS)[number];
export type MachinesWidgetPresetNames = Readonly<{
  overview: string;
  machineHealth: string;
}>;
export type MachinesWidgetPresetMachine = Readonly<{
  serverId: string;
  machineId: string;
}>;

const widget = (
  id: string,
  definition: MachineBuiltinWidgetIdV1,
  size: WidgetSizeV1,
  bindings: WidgetInputBindingsV1 = {},
): WidgetLayoutItemV1 => ({
  kind: 'widget',
  size,
  frameStyle: 'card',
  instance: {
    v: 1,
    id,
    definition: { kind: 'builtin', id: definition },
    bindings,
  },
});

/**
 * The All machines dashboard's host preset (plan 60 AGW-19, D5 static, amended 2026-10-11): one Card · Lines
 * group whose Machine input is pinned to the machine that needs the person (or this computer) when the page
 * first offers it — Vitals, Guard and Storage follow the group — then Activity across every machine. The page's
 * own needs-you list owns that fact, so the Machines widget is not in the default (it stays in Add), and
 * the group is titled for what it holds, not "Needs you". Without a machine it keeps its place and its
 * inputs available to organize; attention clearing never removes the person's dashboard. Named views,
 * Reset and Undo are the platform's (AR-4); this only declares the default.
 */
export function createMachinesWidgetPresets(
  names: MachinesWidgetPresetNames,
  options: Readonly<{ machine: MachinesWidgetPresetMachine | null }>,
): readonly WidgetAreaPresetV1[] {
  const follow: WidgetInputBindingsV1 = { machine: { kind: 'context', slot: 'machine' } };
  const items: WidgetLayoutItemV1[] = [
    instantiateWidgetLayoutFragmentGroupV1(
      {
        width: 'full',
        title: names.machineHealth,
        titleKey: 'machines.widgets.body.presets.machineHealth',
        frameStyle: 'card',
        dividers: 'hairline',
        context: options.machine ? {
          machine: {
            kind: 'value',
            value: {
              serverId: options.machine.serverId,
              machineId: options.machine.machineId,
            },
          },
        } : {},
        children: [
          {
            kind: 'widget',
            size: 'medium',
            frameStyle: 'plain',
            instance: {
              v: 1,
              definition: { kind: 'builtin', id: 'machine_vitals' },
              bindings: follow,
            },
          },
          {
            kind: 'widget',
            size: 'medium',
            frameStyle: 'plain',
            instance: {
              v: 1,
              definition: { kind: 'builtin', id: 'machine_guard' },
              bindings: follow,
            },
          },
          {
            kind: 'widget',
            size: 'medium',
            frameStyle: 'plain',
            instance: {
              v: 1,
              definition: { kind: 'builtin', id: 'machine_storage' },
              bindings: follow,
            },
          },
        ],
      },
      {
        groupId: 'overview:group:0',
        childIds: [
          'overview:group:0:widget:0',
          'overview:group:0:widget:1',
          'overview:group:0:widget:2',
        ],
      },
    ),
    widget('overview:activity', 'machine_activity', 'wide'),
  ];
  return [{ id: 'overview', name: names.overview, items }];
}
