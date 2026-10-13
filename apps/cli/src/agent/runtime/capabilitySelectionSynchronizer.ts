import type { Metadata } from '@/api/types';
import { readCapabilityLaunchRestartFromMetadataV1, readSessionCapabilityAgentFactsV1, resolveCapabilityApplyTimingV1, type CapabilityApplyTimingInputV1 } from '@happier-dev/protocol/reach/capabilityApplyTimingV1';
import type { RestartSessionRunnerRequestV1, RestartSessionRunnerResultV1 } from '@happier-dev/protocol';
import type { SessionSkillsReapplyRunner } from '@/prompts/skills/runtime/reapplySessionSkills';
import type { RunnerSkillsTransports } from '@/prompts/skills/runtime/resolveRunnerSkills';
import { logger } from '@/ui/logger';
import { areSessionCapabilitySelectionsEquivalentV1, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { readAppliedSessionCapabilitySelectionFromMetadataV1, readSessionCapabilitySelectionFromMetadataV1,
  readCapabilitySelectionApplyV1, resolveSelectionRestartMarkersForStartupV1, writeCapabilitySelectionApplyV1,
  type CapabilitySelectionApplyV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1';

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
  requestRestart?: (request: RestartSessionRunnerRequestV1) => Promise<RestartSessionRunnerResultV1>;
}>;

export function createCapabilitySelectionSynchronizer(input: CapabilitySelectionSynchronizerInput) {
  let applied = readAppliedSessionCapabilitySelectionFromMetadataV1(input.session.getMetadataSnapshot());
  let desired = readSessionCapabilitySelectionFromMetadataV1(input.session.getMetadataSnapshot());
  let blocked = false;
  let restartAccepted = false;
  let applying: Promise<void> | null = null;
  let waitForNextSettlement = false;
  let metadataApplyScheduled = false;
  let observedAgentFacts = readSessionCapabilityAgentFactsV1(input.session.getMetadataSnapshot());
  let lastSettledTurnId: string | undefined;

  const observe = () => {
    const next = readSessionCapabilitySelectionFromMetadataV1(input.session.getMetadataSnapshot());
    const nextAgentFacts = readSessionCapabilityAgentFactsV1(input.session.getMetadataSnapshot());
    if (JSON.stringify(nextAgentFacts) !== JSON.stringify(observedAgentFacts)) blocked = false;
    observedAgentFacts = nextAgentFacts;
    if (!areSessionCapabilitySelectionsEquivalentV1(desired, next)) blocked = false;
    desired = next;
  };
  const pending = () => ({
    mcp: !areSessionCapabilitySelectionsEquivalentV1({ mcp: applied.mcp }, { mcp: desired.mcp }),
    skills: !areSessionCapabilitySelectionsEquivalentV1({ skills: applied.skills }, { skills: desired.skills }),
  });
  const publishReason = async (captured: Required<SessionCapabilitySelectionV1>, kinds: Readonly<{ mcp: boolean; skills: boolean }>,
    status: NonNullable<CapabilitySelectionApplyV1['mcp']>) => {
    await input.session.updateMetadataAsCurrentPublisher(metadata => {
      // Active presence can expire while the process remains alive. Restore the
      // known runtime baseline if an offline desired write carried no marker.
      const withAppliedBaseline = resolveSelectionRestartMarkersForStartupV1({ current: metadata, applied });
      const current = readSessionCapabilitySelectionFromMetadataV1(withAppliedBaseline);
      const previous = readCapabilitySelectionApplyV1(withAppliedBaseline);
      return writeCapabilitySelectionApplyV1(withAppliedBaseline, {
        ...previous,
        ...(kinds.mcp && areSessionCapabilitySelectionsEquivalentV1({ mcp: captured.mcp }, { mcp: current.mcp }) ? { mcp: status } : {}),
        ...(kinds.skills && areSessionCapabilitySelectionsEquivalentV1({ skills: captured.skills }, { skills: current.skills }) ? { skills: status } : {}),
      });
    }).catch(() => {
      logger.debug('[CapabilitySelection] Apply status publication unavailable; selection remains pending');
    });
  };

  const apply = async () => {
    observe();
    if (!input.isStarted() || !input.isSettled() || blocked || restartAccepted) return;
    const captured = desired;
    const agent = readSessionCapabilityAgentFactsV1(input.session.getMetadataSnapshot()) ?? input.agent;
    const kinds = pending();
    if (!kinds.mcp && !kinds.skills) return;
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
    if (applying) return applying;
    const attemptedSelection = desired;
    applying = apply().catch(async () => {
      blocked = true;
      await publishReason(desired, pending(), { reason: 'apply_failed' });
    }).finally(() => {
      applying = null;
      if (!blocked && !waitForNextSettlement && !restartAccepted && input.isSettled()
        && !areSessionCapabilitySelectionsEquivalentV1(attemptedSelection, desired)) {
        void flush();
      }
    });
    return applying;
  };
  return {
    syncFromMetadata: () => {
      observe();
      if (!input.isStarted() || !input.isSettled() || waitForNextSettlement || metadataApplyScheduled) return;
      metadataApplyScheduled = true;
      void Promise.resolve().then(async () => {
        metadataApplyScheduled = false;
        if (!waitForNextSettlement) await flush();
      }).catch(error => logger.debug('[CapabilitySelection] Apply status publication failed', { error: String(error) }));
    },
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
