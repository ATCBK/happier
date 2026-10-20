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

/**
 * The preset's health group is pinned to the first machine that needs the
 * person, else this computer while it is online, else the fleet's first online machine, else the first that has reported its resources,
 * else the fleet's first machine. A browser is no machine, so a fleet page opened from one still binds the group:
 * never three "Machine is still needed" cards. Until the census loads, only positive online evidence can take the pin:
 * a warm offline row or stale publication cannot lock it before an online machine arrives. A publication can outlive its machine going
 * away, so "reports" never outranks "is online".
 */
export function selectMachinesPresetMachine(input: Readonly<{
  serverId: string | null;
  presenceLoaded: boolean;
  needsYou: readonly Readonly<{ serverId?: string | null; machineId: string }>[];
  thisComputerMachineId: string | null;
  /** `JSON.stringify([serverId, machineId])`, as the fleet attention owner publishes them. */
  reportingMachineKeys: readonly string[];
  /**
   * The fleet as the page lists it: its first online machine, its first machine, and which are online
   * (`JSON.stringify([serverId, machineId])`).
   */
  fleet?: Readonly<{ firstOnline: MachinesWidgetPresetMachine | null; first: MachinesWidgetPresetMachine | null; onlineKeys?: readonly string[] }>;
}>): MachinesWidgetPresetMachine | null {
  const first = input.needsYou[0];
  if (first?.serverId) return { serverId: first.serverId, machineId: first.machineId };
  // This computer leads only while it can report: offline, it would pin the group to "last seen" three times over
  // while another machine is online.
  const thisComputerAway = Boolean(input.fleet?.firstOnline && input.fleet.onlineKeys
    && !input.fleet.onlineKeys.includes(JSON.stringify([input.serverId, input.thisComputerMachineId])));
  if (input.thisComputerMachineId && input.serverId && !thisComputerAway
    && (input.presenceLoaded || input.fleet?.onlineKeys?.includes(JSON.stringify([input.serverId, input.thisComputerMachineId])))) {
    return { serverId: input.serverId, machineId: input.thisComputerMachineId };
  }
  if (input.fleet?.firstOnline) return input.fleet.firstOnline;
  if (!input.presenceLoaded) return null;
  for (const key of input.reportingMachineKeys) {
    const parsed: unknown = JSON.parse(key);
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return { serverId: parsed[0], machineId: parsed[1] };
    }
  }
  return input.fleet?.first ?? null;
}

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
