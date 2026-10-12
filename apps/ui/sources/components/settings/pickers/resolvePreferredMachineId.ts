import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import type { MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';

type RecentMachinePathEntry = Readonly<{ machineId?: string | null }> | null | undefined;

function normalizeId(value: unknown): string {
  return String(value ?? '').trim();
}

function pushUniqueMachineId(next: string[], seen: Set<string>, value: unknown): void {
  const machineId = normalizeId(value);
  if (!machineId || seen.has(machineId)) return;
  seen.add(machineId);
  next.push(machineId);
}

export function listPreferredMachineIds(params: Readonly<{
  scope?: MachineReachabilityScope | null;
  machines: ReadonlyArray<Machine>;
  recentMachinePaths: ReadonlyArray<RecentMachinePathEntry>;
  preferredMachineId?: string | null;
  onlineOnly?: boolean;
}>): string[] {
  const machines = Array.isArray(params.machines) ? params.machines : [];
  const recentMachinePaths = Array.isArray(params.recentMachinePaths) ? params.recentMachinePaths : [];
  const preferredMachineId = normalizeId(params.preferredMachineId);
  const onlineOnly = params.onlineOnly === true;
  const machineById = new Map(machines.map((machine) => [normalizeId(machine.id), machine] as const));
  const ordered: string[] = [];
  const seen = new Set<string>();

  const pushIfEligible = (machineId: unknown) => {
    const normalizedMachineId = normalizeId(machineId);
    if (!normalizedMachineId) return;
    const machine = machineById.get(normalizedMachineId);
    if (!machine) return;
    if (onlineOnly && !isMachineSelectableForFleet(params.scope, machine)) return;
    pushUniqueMachineId(ordered, seen, normalizedMachineId);
  };

  if (preferredMachineId) {
    pushIfEligible(preferredMachineId);
  }

  for (const recent of recentMachinePaths) {
    pushIfEligible(recent?.machineId);
  }

  for (const machine of machines) {
    if (isMachineSelectableForFleet(params.scope, machine)) {
      pushUniqueMachineId(ordered, seen, machine.id);
    }
  }

  if (onlineOnly) {
    return ordered;
  }

  if (preferredMachineId) {
    pushUniqueMachineId(ordered, seen, preferredMachineId);
  }

  for (const recent of recentMachinePaths) {
    pushUniqueMachineId(ordered, seen, recent?.machineId);
  }

  for (const machine of machines) {
    pushUniqueMachineId(ordered, seen, machine.id);
  }

  return ordered;
}

export function resolvePreferredMachineId(params: Readonly<{
  scope?: MachineReachabilityScope | null;
  machines: ReadonlyArray<Machine>;
  recentMachinePaths: ReadonlyArray<RecentMachinePathEntry>;
  preferredMachineId?: string | null;
  onlineOnly?: boolean;
}>): string | null {
  return listPreferredMachineIds(params)[0] ?? null;
}

/**
 * The machine a launch starts on when nobody chose one: the preferred order among online
 * machines, and only when none is online the same order over every machine.
 */
export function resolvePreferredLaunchMachineId(params: Readonly<{
  scope?: MachineReachabilityScope | null;
  machines: ReadonlyArray<Machine>;
  recentMachinePaths: ReadonlyArray<RecentMachinePathEntry>;
  preferredMachineId?: string | null;
}>): string | null {
  return resolvePreferredMachineId({ ...params, onlineOnly: true })
    ?? resolvePreferredMachineId(params);
}
