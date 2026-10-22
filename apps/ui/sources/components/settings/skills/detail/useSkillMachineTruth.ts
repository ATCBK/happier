import * as React from 'react';
import { SpawnCapabilitiesPreviewOutputV1Schema } from '@happier-dev/protocol/actions/specs/sessionCapabilities';

import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type {
  ReachMachine,
  ReachMachineProjection,
} from '@/sync/domains/capabilities/reach/useReachProjection';

import { skillPlanOnMachine } from '../skillsCollectionModel';

/** What one Agent on one online machine gets, as that machine's own plan says (P3 item states). */
export type SkillAgentFact =
  | Readonly<{ kind: 'pending' }>
  | Readonly<{ kind: 'delivered' }>
  | Readonly<{ kind: 'masked' }>
  | Readonly<{ kind: 'off' }>
  | Readonly<{ kind: 'failed'; reason: string }>;

export type SkillMachineTruth = Readonly<{
  machine: ReachMachine;
  /** Agents here that can load skills (P3 plan kind is not `none`). */
  skillAgents: readonly string[];
  /** Agents installed here that cannot load skills. */
  cannotLoad: readonly string[];
  /** Online: one fact per skill-capable Agent from its preview. Offline: the projection only. */
  facts: ReadonlyMap<string, SkillAgentFact>;
  /** Offline: the Agents the rules reach (last-known install facts). */
  projectedAgents: readonly string[];
}>;

type Execute = (
  actionId: 'sessions.spawn.capabilities.preview',
  input: unknown,
  operation?: Readonly<{ signal?: AbortSignal }>,
) => Promise<ActionExecuteResult>;

/**
 * "On your machines" (IR-74): for each **online** machine and each installed Agent there that can load
 * skills, the existing machine-placed `sessions.spawn.capabilities.preview` is asked once, at machine
 * level (no `directory`), so each Agent's row states its own fact (a native copy can win for Claude while
 * Codex gets the library's). One failed preview leaves the others in place. Offline machines are never
 * asked; their rows are the reach projection, dated by the caller. `rulesKey` re-asks after a rule change.
 */
export function useSkillMachineTruth(
  input: Readonly<{
    skillId: string | null;
    machines: readonly ReachMachine[];
    projection: readonly ReachMachineProjection[];
    rulesKey: string;
    execute: Execute;
    ready: boolean;
  }>,
): readonly SkillMachineTruth[] {
  const { skillId, machines, projection, rulesKey, execute, ready } = input;
  const targets = React.useMemo(
    () =>
      machines.map((machine) => {
        const installed = machine.agentIds;
        const skillAgents = installed.filter(
          (agentId) => skillPlanOnMachine(machine, agentId) !== 'none',
        );
        return {
          machine,
          skillAgents,
          cannotLoad: installed.filter(
            (agentId) => !skillAgents.includes(agentId),
          ),
        };
      }),
    [machines],
  );
  // The asked set: online machine × skill-capable Agent. A stable key so a presence echo does not re-ask.
  const asked = React.useMemo(
    () =>
      targets.flatMap((target) =>
        target.machine.online !== true
          ? []
          : target.skillAgents.map(
              (agentId) => `${target.machine.machineId}\u0000${agentId}`,
            ),
      ),
    [targets],
  );
  const askedKey = asked.join('\u0001');
  const [facts, setFacts] = React.useState<ReadonlyMap<string, SkillAgentFact>>(
    () => new Map(),
  );

  React.useEffect(() => {
    if (!skillId || !ready || asked.length === 0) return;
    const controller = new AbortController();
    setFacts(new Map(asked.map((key) => [key, { kind: 'pending' } as const])));
    for (const key of asked) {
      const [machineId, agentId] = key.split('\u0000') as [string, string];
      void (async () => {
        let fact: SkillAgentFact;
        try {
          const result = await execute(
            'sessions.spawn.capabilities.preview',
            { machineId, agentId },
            { signal: controller.signal },
          );
          const parsed = result.ok
            ? SpawnCapabilitiesPreviewOutputV1Schema.safeParse(result.result)
            : null;
          if (!result.ok)
            fact = {
              kind: 'failed',
              reason: result.errorCode ?? result.error ?? 'unavailable',
            };
          else if (!parsed?.success)
            fact = { kind: 'failed', reason: 'invalid_action_output' };
          else if (!parsed.data.ok)
            fact = { kind: 'failed', reason: parsed.data.reason };
          else {
            const item = parsed.data.skills.items.find(
              (entry) => entry.id === skillId,
            );
            fact =
              !item || !item.selected
                ? { kind: 'off' }
                : item.state === 'masked_by_native'
                  ? { kind: 'masked' }
                  : item.state === 'delivered' || item.state === undefined
                    ? { kind: 'delivered' }
                    : item.state === 'unavailable' ||
                        item.state === 'name_conflict'
                      ? { kind: 'failed', reason: item.state }
                      : { kind: 'off' };
          }
        } catch (error) {
          fact = {
            kind: 'failed',
            reason: error instanceof Error ? error.message : 'unavailable',
          };
        }
        if (controller.signal.aborted) return;
        setFacts((previous) => new Map(previous).set(key, fact));
      })();
    }
    return () => controller.abort();
    // `asked` is keyed by `askedKey`; `rulesKey` re-asks after the person changes where it's on.
  }, [askedKey, execute, ready, rulesKey, skillId]);

  return React.useMemo(
    () =>
      targets.map((target) => {
        const row = projection.find(
          (entry) =>
            entry.machineId === target.machine.machineId &&
            entry.projectKey === undefined,
        );
        const projectedAgents =
          row?.agents
            .filter(
              (agent) =>
                agent.enabled && target.skillAgents.includes(agent.agentId),
            )
            .map((agent) => agent.agentId) ?? [];
        const machineFacts = new Map<string, SkillAgentFact>();
        if (target.machine.online === true) {
          for (const agentId of target.skillAgents) {
            const fact = facts.get(
              `${target.machine.machineId}\u0000${agentId}`,
            );
            if (fact) machineFacts.set(agentId, fact);
          }
        }
        return {
          machine: target.machine,
          skillAgents: target.skillAgents,
          cannotLoad: target.cannotLoad,
          facts: machineFacts,
          projectedAgents,
        };
      }),
    [facts, projection, targets],
  );
}
