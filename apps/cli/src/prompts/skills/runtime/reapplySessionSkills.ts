import type { AgentSessionRuntime, AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import { createRunnerSkillsCurrentnessCheck, resolveRunnerSkills, type ResolveRunnerSkillsInput, type RunnerSkillsResult, type RunnerSkillsTransports } from './resolveRunnerSkills';
import { resolveAgentSkillsCapability } from '@/agent/skills/resolveAgentSkillsCapability';

export type ReapplySessionSkillsResult = Readonly<{ applied: 'live' }>
  | Readonly<{ applied: 'next_turn' | 'failed'; reason: string }>;
export type SessionSkillsReapplyRunner = Readonly<{
  readInput: () => ResolveRunnerSkillsInput;
  runtime: Pick<AgentSessionRuntime, 'refreshSkills'>;
  onApplied: (result: RunnerSkillsResult) => void;
}>;

/** The host replaces current only through onApplied after native reload acknowledgement. */
export function readAppliedSessionSkillDelivery(input: Readonly<{
  current: RunnerSkillsResult | null;
  initialDelivery: AgentSessionSkillDelivery | undefined;
  skillsDelivered: boolean | undefined;
}>): AgentSessionSkillDelivery | undefined {
  const delivery = input.current?.delivery;
  return input.skillsDelivered === false && delivery === input.initialDelivery ? undefined : delivery;
}

export async function reapplySessionSkills(
  runner: SessionSkillsReapplyRunner,
  transports: RunnerSkillsTransports = {},
): Promise<ReapplySessionSkillsResult> {
  const input = runner.readInput();
  if (resolveAgentSkillsCapability(input.agentId, input.contributes).liveReload !== 'supported') {
    return { applied: 'next_turn', reason: 'live_reload_unsupported' };
  }
  const assertCurrent = createRunnerSkillsCurrentnessCheck(input);
  const resolved = await resolveRunnerSkills({ ...input, lifecycle: 'reapply' }, transports);
  if (resolved.plan.diagnostics.some(diagnostic => diagnostic.kind === 'native_scan_failed')) {
    return { applied: 'failed', reason: 'native_scan_failed' };
  }
  if (resolved.unavailable || !resolved.delivery) return { applied: 'failed', reason: 'skills_unavailable' };
  // The declaration authorizes this control; method presence never opts an Agent into reload.
  if (!runner.runtime.refreshSkills) return { applied: 'failed', reason: 'refresh_failed' };
  try {
    const refreshed = await runner.runtime.refreshSkills({ skills: resolved.delivery });
    if (refreshed.kind === 'restart_required') return { applied: 'next_turn', reason: refreshed.reason };
    try { await assertCurrent(); }
    catch { return { applied: 'failed', reason: 'skills_unavailable' }; }
    runner.onApplied(resolved);
    return { applied: 'live' };
  } catch {
    return { applied: 'failed', reason: 'refresh_failed' };
  }
}
