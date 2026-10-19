import type { SessionWorkStateV1 } from '@happier-dev/plugin-sdk/sessions/work-state';

import {
  createClaudeGoalWorkStateSource,
  type ClaudeGoalWorkStateSource,
} from '../../../transcripts/goalSource.js';
import { buildClaudeGoalCommand } from '../../goalControl/command.js';

/**
 * Centralized native `/goal` runtime for the Claude unified terminal.
 *
 * This single module owns BOTH halves of the goal feature on the live path so
 * the goal wiring is never scattered (the H6 lesson):
 *
 *  - SOURCE: `source.observeTranscriptMessage(row)` is wired into the provider
 *    transcript follow loop's `onObserveRow`, turning `goal_status` attachments +
 *    the system-init `slash_commands` into a published `kind:'goal'` work-state
 *    item. Publishes through a merge-safe metadata update so it coexists with the
 *    todo/task families the outbound dispatch facet derives.
 *  - EFFECTOR: `setGoal`/`clearGoal` inject a terminal-local `/goal …` control into the
 *    running TUI (via the supplied `injectGoalCommand`). The `goal_status`
 *    attachment Claude then emits is the single SOURCE OF TRUTH — the effector
 *    never writes goal state into metadata itself.
 */

type GoalControlError = Readonly<{ ok: false; errorCode: string; error: string }>;

function stableError(errorCode: string): GoalControlError {
  return { ok: false, errorCode, error: errorCode };
}

export type ClaudeGoalCommandDelivery =
  | Readonly<{ kind: 'queued' }>
  | Readonly<{ kind: 'sent-to-terminal' }>;

/** Injects a turn-neutral `/goal …` command into the unified terminal. */
export type ClaudeGoalCommandInjector = (message: string) => Promise<void | ClaudeGoalCommandDelivery>;

export type ClaudeUnifiedGoalRuntime = Readonly<{
  /** The transcript goal source — wire `observeTranscriptMessage` into `onObserveRow`. */
  source: ClaudeGoalWorkStateSource;
  /**
   * ACTIVE-session goal effector. Injects `/goal <objective>` as a terminal-local control.
   * Returns a typed non-fallback error on empty objective / inject failure so the
   * live RPC reports cleanly instead of throwing (which the goal router would
   * treat as a fallback trigger and seed a decorative metadata goal).
   */
  setGoal: (
    objective: string | undefined,
    options?: Readonly<{ status?: string; tokenBudget?: number | null }>,
  ) => Promise<unknown>;
  clearGoal: () => Promise<unknown>;
}>;

const DELIVERY_RANK: Record<ClaudeGoalCommandDelivery['kind'], number> = {
  queued: 0,
  'sent-to-terminal': 1,
};

const ACCEPTED_DELIVERY_THRESHOLD = DELIVERY_RANK['sent-to-terminal'];

function reachedAcceptedThreshold(delivery: void | ClaudeGoalCommandDelivery): boolean {
  if (delivery === undefined) return true;
  return DELIVERY_RANK[delivery.kind] >= ACCEPTED_DELIVERY_THRESHOLD;
}

/**
 * G-1/G-2: Claude's `/goal` command carries an objective ONLY — it cannot enforce a token budget or
 * apply a status transition (pause/complete/…). Requesting either (a `tokenBudget` field, even
 * `null` which is a request to CLEAR the budget, or a `status` transition) is UNSUPPORTED on the
 * Claude live-RPC path. `objective`-only sets are the sole supported mutation and pass through.
 */
function requestsUnsupportedGoalOption(
  options: Readonly<{ status?: string; tokenBudget?: number | null }> | undefined,
): boolean {
  if (!options) return false;
  if (options.tokenBudget !== undefined) return true;
  if (options.status !== undefined) return true;
  return false;
}

export function createClaudeUnifiedGoalRuntime(params: Readonly<{
  backendId: string;
  agentId?: string;
  getCurrentClaudeSessionId: () => string | null;
  publishWorkStateSnapshot?: (snapshot: SessionWorkStateV1, afterGoalCommandAdmission?: boolean) => void | Promise<void>;
  injectGoalCommand: ClaudeGoalCommandInjector;
  logError?: (message: string, error: unknown) => void;
}>): ClaudeUnifiedGoalRuntime {
  const publishWorkStateSnapshot = (snapshot: SessionWorkStateV1, afterGoalCommandAdmission?: boolean): void | Promise<void> => {
    if (params.publishWorkStateSnapshot) {
      return params.publishWorkStateSnapshot(snapshot, afterGoalCommandAdmission);
    }
    params.logError?.(
      'failed to publish Claude goal work-state snapshot (non-fatal)',
      new Error('goal work-state publisher unavailable'),
    );
  };

  const nativeSource = createClaudeGoalWorkStateSource({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    publishWorkStateSnapshot,
    getCurrentClaudeSessionId: params.getCurrentClaudeSessionId,
    ...(params.logError ? { logError: params.logError } : {}),
  });

  const admissions = new Set<Promise<void>>();
  const source: ClaudeGoalWorkStateSource = {
    ...nativeSource,
    observeTranscriptMessage(message) {
      if (admissions.size === 0) return nativeSource.observeTranscriptMessage(message);
      // Native evidence can precede its transport ACK. Apply the accepted
      // control intent before the source decides whether a row is stale replay.
      return Promise.all([...admissions]).then(() => nativeSource.observeTranscriptMessage(message));
    },
  };

  async function deliverGoalCommand(command: string, onDelivered: () => void): Promise<unknown> {
    let settle!: () => void;
    const admission = new Promise<void>(resolve => { settle = resolve; });
    admissions.add(admission);
    try {
      let delivery: void | ClaudeGoalCommandDelivery;
      try {
        delivery = await params.injectGoalCommand(command);
      } catch {
        return stableError('session_goal_control_inject_failed');
      }
      if (!reachedAcceptedThreshold(delivery)) return stableError('session_goal_control_inject_failed');
      try { onDelivered(); } catch { /* Native delivery succeeded; source reconciliation remains best-effort. */ }
      return undefined;
    } finally {
      admissions.delete(admission);
      settle();
    }
  }

  return {
    source,
    setGoal: async (objective, options) => {
      if (requestsUnsupportedGoalOption(options)) {
        // Fail loudly BEFORE injecting: a budget/status mutation cannot be delivered via `/goal`, so
        // pretending it succeeded (or injecting an objective-only command that silently drops it)
        // would leave metadata/runtime disagreeing (G-1/G-2). The errorCode is absent from the goal
        // router's fallback set, so the live RPC reports cleanly instead of seeding a decorative goal.
        return stableError('session_goal_control_unsupported');
      }
      const trimmed = typeof objective === 'string' ? objective.trim() : '';
      if (!trimmed) {
        // Claude `/goal` cannot pursue an empty objective. A non-fallback error
        // keeps the router on the live path and surfaces the failure cleanly.
        return stableError('session_goal_control_objective_required');
      }
      return await deliverGoalCommand(buildClaudeGoalCommand({ type: 'set', objective: trimmed }),
        () => nativeSource.recordGoalSetIntent());
    },
    clearGoal: async () => {
      // The inject succeeded but Claude emits no `goal_status` for a clear (verified live), so remove
      // the work-state goal item directly — otherwise the badge keeps showing the now-stale goal.
      return await deliverGoalCommand(buildClaudeGoalCommand({ type: 'clear' }),
        () => nativeSource.clearGoalWorkState());
    },
  };
}
