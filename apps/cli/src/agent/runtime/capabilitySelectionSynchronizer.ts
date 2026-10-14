import type { Metadata } from '@/api/types';
import { readCapabilityLaunchRestartFromMetadataV1, readSessionCapabilityAgentFactsV1, resolveCapabilityApplyTimingV1, type CapabilityApplyTimingInputV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import type { RestartSessionRunnerRequestV1, RestartSessionRunnerResultV1 } from '@happier-dev/protocol';
import type { SessionSkillsReapplyRunner } from '@/prompts/skills/runtime/reapplySessionSkills';
import type { RunnerSkillsTransports } from '@/prompts/skills/runtime/resolveRunnerSkills';
import { logger } from '@/ui/logger';
import type { ReachContextV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import type { SkillRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { realpathReachRules } from '@/mcp/servers/createRealpathNormalizer';
import { areSessionCapabilitySelectionsEquivalentV1, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { readAppliedSessionCapabilitySelectionFromMetadataV1, readSessionCapabilitySelectionFromMetadataV1,
  resolveSelectionRestartMarkersForStartupV1, patchCapabilitySelectionApplyV1,
  clearCapabilitySelectionApplyV1, readPendingCapabilityApplyV1, readPendingSkillRuleApplyV1,
  type CapabilitySelectionApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';

type SkillRuleObservation = Readonly<{ context: ReachContextV1; rules: readonly SkillRuleV1[] }>;

export type CapabilitySelectionSynchronizerInput = Readonly<{
  session: Readonly<{
    sessionId: string;
    getMetadataSnapshot: () => Metadata | null;
    updateMetadataAsCurrentPublisher: (update: (metadata: Metadata) => Metadata) => Promise<void>;
  }>;
  agent: CapabilityApplyTimingInputV1['agent'];
  isStarted: () => boolean;
  isSettled: () => boolean;
  skillsRunner?: SessionSkillsReapplyRunner;
  skillsTransports?: RunnerSkillsTransports;
  initialSkillRules?: SkillRuleObservation;
  readSkillRules?: () => SkillRuleObservation | null;
  /** Bound through the host's incumbent captured Account subscription. */
  subscribeAccountSettings?: (observe: () => void) => () => void;
  requestRestart?: (request: RestartSessionRunnerRequestV1) => Promise<RestartSessionRunnerResultV1>;
}>;

export function createCapabilitySelectionSynchronizer(input: CapabilitySelectionSynchronizerInput) {
  const initialMetadata = input.session.getMetadataSnapshot();
  let applied = readAppliedSessionCapabilitySelectionFromMetadataV1(initialMetadata);
  let desired = readSessionCapabilitySelectionFromMetadataV1(initialMetadata);
  let blocked = false;
  let restartAccepted = false;
  let applying: Promise<void> | null = null;
  let waitForNextSettlement = false;
  let metadataApplyScheduled = false;
  let observedAgentFacts = readSessionCapabilityAgentFactsV1(initialMetadata);
  let lastSettledTurnId: string | undefined;
  let disposed = false;

  const ruleSelection = (observation: SkillRuleObservation, selection: SessionCapabilitySelectionV1) => {
    const ids = new Set([...observation.rules.map(rule => rule.skillId), ...(selection.skills?.forceIncludeSkillIds ?? [])]);
    const resolved = resolveSessionCapabilitiesV1({ context: observation.context, mcp: null,
      skills: { items: [...ids].map(skillId => ({ skillId, name: skillId })), rules: realpathReachRules(observation.rules) },
      selection, agentAcceptsUserMcp: false });
    return JSON.stringify(resolved.skills.items.filter(item => item.selected).map(item => item.id).sort());
  };
  const initialRules = input.initialSkillRules ?? input.readSkillRules?.();
  // A preserved-process attach cannot infer native application from today's rules.
  let appliedSkillRules = initialRules && !readPendingSkillRuleApplyV1(initialMetadata) ? ruleSelection(initialRules, applied) : null;
  let desiredSkillRules = initialRules ? ruleSelection(initialRules, desired) : appliedSkillRules;
  let skillRulesAvailable = initialRules != null;

  const observe = () => {
    const next = readSessionCapabilitySelectionFromMetadataV1(input.session.getMetadataSnapshot());
    const nextAgentFacts = readSessionCapabilityAgentFactsV1(input.session.getMetadataSnapshot());
    if (JSON.stringify(nextAgentFacts) !== JSON.stringify(observedAgentFacts)) blocked = false;
    observedAgentFacts = nextAgentFacts;
    if (!areSessionCapabilitySelectionsEquivalentV1(desired, next)) blocked = false;
    desired = next;
    const rules = input.readSkillRules?.();
    if (rules) {
      const nextRules = ruleSelection(rules, desired);
      if (nextRules !== desiredSkillRules) blocked = false;
      desiredSkillRules = nextRules;
    }
    skillRulesAvailable = rules != null;
  };
  const pending = () => ({
    mcp: !areSessionCapabilitySelectionsEquivalentV1({ mcp: applied.mcp }, { mcp: desired.mcp }),
    skills: !areSessionCapabilitySelectionsEquivalentV1({ skills: applied.skills }, { skills: desired.skills })
      || skillRulesAvailable && desiredSkillRules !== appliedSkillRules,
  });
  const publishReason = async (captured: Required<SessionCapabilitySelectionV1>, kinds: Readonly<{ mcp: boolean; skills: boolean }>,
    status: NonNullable<CapabilitySelectionApplyV1['mcp']>) => {
    await input.session.updateMetadataAsCurrentPublisher(metadata => {
      // Active presence can expire while the process remains alive. Restore the
      // known runtime baseline if an offline desired write carried no marker.
      const withAppliedBaseline = resolveSelectionRestartMarkersForStartupV1({ current: metadata, applied: {
        ...(kinds.mcp ? { mcp: applied.mcp } : {}), ...(kinds.skills ? { skills: applied.skills } : {}),
      } });
      const current = readSessionCapabilitySelectionFromMetadataV1(withAppliedBaseline);
      return patchCapabilitySelectionApplyV1(withAppliedBaseline, {
        ...(kinds.mcp && areSessionCapabilitySelectionsEquivalentV1({ mcp: captured.mcp }, { mcp: current.mcp }) ? { mcp: status } : {}),
        ...(kinds.skills && areSessionCapabilitySelectionsEquivalentV1({ skills: captured.skills }, { skills: current.skills }) ? { skills: {
          ...status, ...(skillRulesAvailable && desiredSkillRules !== appliedSkillRules ? { source: 'rules' as const } : {}),
        } } : {}),
      });
    }).catch(() => {
      logger.debug('[CapabilitySelection] Apply status publication unavailable; selection remains pending');
    });
  };

  const apply = async () => {
    observe();
    if (disposed || !input.isStarted() || blocked || restartAccepted) return;
    const captured = desired;
    const capturedSkillRules = desiredSkillRules;
    const agent = readSessionCapabilityAgentFactsV1(input.session.getMetadataSnapshot()) ?? input.agent;
    const kinds = pending();
    if (!kinds.mcp && !kinds.skills) {
      if (skillRulesAvailable && desiredSkillRules === appliedSkillRules
        && readPendingCapabilityApplyV1(input.session.getMetadataSnapshot()).skills) {
        await input.session.updateMetadataAsCurrentPublisher(metadata => clearCapabilitySelectionApplyV1(metadata, 'skills'));
      }
      return;
    }
    // Rules can change without a desired-selection marker. Publish that pending
    // fact before waiting for settlement or native acknowledgment, through the
    // same status owner used for an apply refusal.
    if (kinds.skills && skillRulesAvailable && desiredSkillRules !== appliedSkillRules
      && !readPendingSkillRuleApplyV1(input.session.getMetadataSnapshot())) {
      await publishReason(captured, { mcp: false, skills: true }, { reason: 'next_turn' });
    }
    if (!input.isSettled()) return;
    const nativeChanged = !areSessionCapabilitySelectionsEquivalentV1(
      { skills: { ...applied.skills, forceIncludeSkillIds: [], forceExcludeSkillIds: [] } },
      { skills: { ...captured.skills, forceIncludeSkillIds: [], forceExcludeSkillIds: [] } });
    const launchRestart = readCapabilityLaunchRestartFromMetadataV1(input.session.getMetadataSnapshot());
    if (kinds.skills && !nativeChanged && agent.skillsLiveReload === 'supported' && input.skillsRunner) {
      const runner = input.skillsRunner;
      const capturedInput = runner.readInput();
      const { reapplySessionSkills } = await import('@/prompts/skills/runtime/reapplySessionSkills');
      const result = await reapplySessionSkills({ ...runner, readInput: () => capturedInput }, input.skillsTransports);
      if (result.applied === 'live') {
        await input.session.updateMetadataAsCurrentPublisher(metadata => resolveSelectionRestartMarkersForStartupV1({
          current: metadata, applied: { skills: captured.skills },
        }));
        applied = { ...applied, skills: captured.skills };
        appliedSkillRules = capturedSkillRules;
        kinds.skills = false;
      }
    }
    if (!kinds.mcp && !kinds.skills) return;
    const timing = resolveCapabilityApplyTimingV1({ kind: kinds.mcp ? 'mcp_server' : nativeChanged ? 'native_skill' : 'skill',
      sessionRunning: true, agent: { ...agent, skillsLiveReload: 'unsupported' }, launchRestart });
    if (timing.t !== 'next_turn') {
      blocked = true;
      await publishReason(captured, kinds, { reason: timing.t, ...(timing.t === 'restart_to_apply' ? { restartBy: timing.restartBy } : {}) });
      return;
    }
    // The daemon rechecks active turns and approvals immediately before signaling.
    const requestRestart = input.requestRestart ?? (await import('@/daemon/controlClient')).requestDaemonSessionRunnerRestart;
    const result = await requestRestart({
      sessionId: input.session.sessionId, mode: 'force_current_cli', reason: 'capability_selection_change',
    });
    if (result.ok && result.status === 'restarted') {
      restartAccepted = true;
      return;
    }
    const busy = result.status === 'busy' && (result.reasonCode === 'turn_in_progress' || result.reasonCode === 'approval_pending');
    waitForNextSettlement = busy;
    blocked = !busy;
    const refusal = result.reasonCode;
    const refusalTiming = refusal === 'windows_hosted_runner' || refusal === 'not_daemon_started' || refusal === 'not_remote_started'
      ? resolveCapabilityApplyTimingV1({ kind: kinds.mcp ? 'mcp_server' : 'native_skill', sessionRunning: true,
        agent: { ...agent, skillsLiveReload: 'unsupported' }, launchRestart: { refused: refusal } }) : null;
    await publishReason(captured, kinds, refusalTiming?.t === 'restart_to_apply'
      ? { reason: refusalTiming.t, restartBy: refusalTiming.restartBy }
      : { reason: result.status === 'missing_resume_snapshot' ? result.status : result.reasonCode ?? result.status });
  };

  const flush = (): Promise<void> => {
    if (applying) return applying.then(() => {
      // A settlement wake may arrive while the earlier busy-turn publication
      // is finishing. Drain that work, then apply the still-pending change.
      const kinds = pending();
      if (!disposed && input.isStarted() && input.isSettled() && !blocked && !restartAccepted
        && !waitForNextSettlement && (kinds.mcp || kinds.skills)) return flush();
    });
    const attemptedSelection = desired;
    const attemptedSkillRules = desiredSkillRules;
    applying = apply().catch(async () => {
      blocked = true;
      await publishReason(desired, pending(), { reason: 'apply_failed' });
    }).finally(() => {
      applying = null;
      if (!disposed && !blocked && !waitForNextSettlement && !restartAccepted && input.isSettled()
        && (!areSessionCapabilitySelectionsEquivalentV1(attemptedSelection, desired) || attemptedSkillRules !== desiredSkillRules)) {
        void flush();
      }
    });
    return applying;
  };
  const syncFromMetadata = () => {
    if (disposed) return;
    observe();
    if (!input.isStarted() || waitForNextSettlement || metadataApplyScheduled) return;
    metadataApplyScheduled = true;
    void Promise.resolve().then(async () => {
      metadataApplyScheduled = false;
      if (!waitForNextSettlement) await flush();
    }).catch(error => logger.debug('[CapabilitySelection] Apply status publication failed', { error: String(error) }));
  };
  const unsubscribeAccountSettings = input.subscribeAccountSettings?.(syncFromMetadata);
  return {
    syncFromMetadata,
    dispose: async () => { disposed = true; unsubscribeAccountSettings?.(); },
    flushBeforeTurn: () => waitForNextSettlement ? Promise.resolve() : flush(),
    flushAfterSettledTurn: (turnId?: string) => {
      if (!input.isSettled()) return Promise.resolve();
      if (turnId !== undefined && turnId === lastSettledTurnId) return applying ?? Promise.resolve();
      lastSettledTurnId = turnId;
      waitForNextSettlement = false;
      return flush();
    },
  };
}
