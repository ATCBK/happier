import * as React from 'react';
import {
  projectReachForMachinesV1,
  type ReachProjectionV1,
} from '@happier-dev/protocol/reach/projectReachV1';
import type { ReachRulesV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { useReachRulesCatalog } from '@/sync/store/useReachRulesCatalog';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useProjectAccountRows } from '@/sync/domains/workspaces/projectAccountRows';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { readInstalledMachineAgentInventory } from './installedMachineAgents';
import { getAcpCatalogSnapshot, subscribeAcpCatalogSnapshots } from '@/sync/store/settings/acpCatalogSnapshot';
import type { PluginProjectionV2 } from '@happier-dev/protocol';
import {
  readDaemonMergedProjectionSummary,
  subscribeDaemonMergedProjectionSummary,
  type DaemonMergedProjectionSummary,
} from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

export type ReachMachineProjection = Readonly<
  ReachProjectionV1[number] & { offline: boolean; projectKey?: string; agentInventoryComplete?: boolean }
>;
const empty: readonly ReachMachineProjection[] = Object.freeze([]);

/** One Account machine as reach sees it: published install facts and REACH's presence predicate. */
export type ReachMachine = Readonly<{
  machineId: string;
  platform: 'win32' | 'posix' | null;
  /** The machine's own published OS and CPU (`darwin`/`linux`/`win32`, `arm64`/`x64`): platform-fit facts, null while unknown. */
  os?: string | null;
  arch?: string | null;
  agentIds: readonly string[];
  /** Configured instance inventory may still be unknown even while its factory is published. */
  agentInventoryComplete?: boolean;
  /** Per-Machine declarations from the existing inert catalog cache; absent while cold. */
  agentDeclarationsById?: PluginProjectionV2['agentsById'] | null;
  /** Display name from the presence owner; null while unknown. */
  name: string | null;
  offline: boolean;
  /** When an offline machine was last seen; null when online or unknown. */
  lastSeenAt: number | null;
}>;

/**
 * Published install facts work on a fresh device and remain available offline. Retained
 * metadata without that projection can use device-cache facts without starting RPCs.
 */
export function useReachMachines(): Readonly<{
  scope: Readonly<{ serverId: string; accountId: string }> | null;
  machines: readonly ReachMachine[];
}> {
  const activeScope = useAccountSettingsScope();
  const serverId = activeScope?.serverId;
  const accountId = activeScope?.accountId;
  const scope = React.useMemo(
    () => (serverId && accountId ? { serverId, accountId } : null),
    [serverId, accountId],
  );
  const inventory = useAllProfileMachineInventorySnapshots();
  const machines = React.useMemo(
    () =>
      inventory.flatMap((row) =>
        row.kind === 'resolved' &&
        scope &&
        row.accountId === scope.accountId &&
        areServerProfileIdentifiersEquivalent(row.profileId, scope.serverId)
          ? row.machines
          : [],
      ),
    [inventory, scope],
  );
  const machineIds = React.useMemo(
    () => machines.map((machine) => machine.id),
    [machines],
  );
  const installed = useMachineAgentsByMachine({
    serverId: scope?.serverId ?? '',
    machineIds,
    load: false,
  });
  const presence = useMachinePresenceSummaries(scope?.serverId, machineIds);
  const declarationsRef = React.useRef<readonly DaemonMergedProjectionSummary[]>([]);
  const readDeclarations = React.useCallback(() => {
    const next = machineIds.map(machineId => readDaemonMergedProjectionSummary({ machineId, serverId }));
    const previous = declarationsRef.current;
    if (previous.length === next.length && next.every((row, index) => row === previous[index])) return previous;
    declarationsRef.current = next;
    return next;
  }, [machineIds, serverId]);
  const subscribeDeclarations = React.useCallback((listener: () => void) => {
    const disposers = machineIds.map(machineId => subscribeDaemonMergedProjectionSummary({ machineId, serverId }, listener));
    return () => { for (const dispose of disposers) dispose(); };
  }, [machineIds, serverId]);
  const declarations = React.useSyncExternalStore(subscribeDeclarations, readDeclarations, readDeclarations);
  const readAcp = React.useCallback(() => getAcpCatalogSnapshot(scope), [scope]);
  const acp = React.useSyncExternalStore(subscribeAcpCatalogSnapshots, readAcp, readAcp);
  const definitionIds = React.useMemo(() => acp?.data?.definitions.map(definition => definition.id), [acp?.data]);
  const reach = React.useMemo(
    () =>
      machines.map((machine, index): ReachMachine => {
        const inventory = readInstalledMachineAgentInventory(machine.metadata?.agentInventory, installed.get(machine.id), definitionIds);
        return {
          machineId: machine.id,
          platform:
            machine.metadata?.platform === 'win32'
              ? 'win32'
              : machine.metadata?.platform
                ? 'posix'
                : null,
          os: machine.metadata?.platform ?? null,
          arch: machine.metadata?.arch ?? null,
          agentIds: inventory.agentIds,
          agentInventoryComplete: inventory.complete,
          agentDeclarationsById: declarations[index]?.inputs?.agentDeclarationsById ?? null,
          name: presence[index]?.name ?? null,
          offline: presence[index]?.reachability === 'unreachable',
          lastSeenAt: presence[index]?.lastSeenAt ?? null,
        };
      }),
    [machines, installed, presence, declarations, definitionIds],
  );
  return React.useMemo(() => ({ scope, machines: reach }), [scope, reach]);
}

/** One item's reach on each Account machine, through P2's projection. */
export function projectReachOnMachines(
  rules: ReachRulesV1,
  machines: readonly ReachMachine[],
  projectKey?: string,
  workspaceRefs: readonly WorkspaceRefV1[] = [],
): readonly ReachMachineProjection[] {
  const projected: ReachMachineProjection[] = projectReachForMachinesV1(rules, { projectKey, machines }).map(
    (row, index) => ({ ...row, offline: machines[index]?.offline ?? false,
      agentInventoryComplete: machines[index]?.agentInventoryComplete }),
  );
  if (projectKey) return projected;
  const projectKeys = new Set(rules.flatMap(rule => rule.target.t === 'project' ? [rule.target.projectKey] : []));
  for (const key of projectKeys) {
    const machineIds = new Set(workspaceRefs.filter(ref => (ref.projectKey ?? ref.id) === key).map(ref => ref.machineId));
    const members = machines.filter(machine => machineIds.has(machine.machineId));
    projected.push(...projectReachForMachinesV1(rules, { projectKey: key, machines: members })
      .map((row, index) => ({ ...row, projectKey: key, offline: members[index]?.offline ?? false,
        agentInventoryComplete: members[index]?.agentInventoryComplete })));
  }
  return projected;
}

/** Passive Machine facts: offline machines retain their installed-Agent observations. */
export function useReachProjection(
  kind: 'skill' | 'mcp_server',
  itemId: string,
  opts?: Readonly<{ projectKey?: string }>,
): readonly ReachMachineProjection[] {
  const catalog = useReachRulesCatalog(kind, itemId);
  const { scope, machines } = useReachMachines();
  const projects = useProjectAccountRows();
  return React.useMemo(
    () =>
      !scope || !catalog.valueAvailable
        ? empty
        : projectReachOnMachines(catalog.rules, machines, opts?.projectKey,
          areServerAccountScopesEqual(scope, projects?.scope)
            ? projects?.workspaceRefs.filter(ref => areServerProfileIdentifiersEquivalent(ref.serverId, scope.serverId)) : []),
    [scope, catalog.valueAvailable, catalog.rules, opts?.projectKey, machines, projects],
  );
}
