import type {
  AgentSessionGoalControl,
  AgentSessionGoalMutation,
  AgentSessionGoalMutationResult,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { SessionGoalControlFailureV1Schema } from '@happier-dev/plugin-sdk/agents/runtime';

export type ClaudeNativeGoalOperations = Readonly<{
  setGoal?(
    objective: string | undefined,
    options?: Readonly<{ status?: string; tokenBudget?: number | null }>,
  ): Promise<unknown>;
  clearGoal?(): Promise<unknown>;
}>;

function diagnostic(code: string) {
  return { code, severity: 'error' as const, message: code };
}

function unsupported(code: string): AgentSessionGoalMutationResult {
  return { status: 'unsupported', diagnostic: diagnostic(code) };
}

function unavailable(code: string): AgentSessionGoalMutationResult {
  return {
    status: 'unavailable',
    retryable: true,
    diagnostic: diagnostic(code),
  };
}

function readObjective(mutation: AgentSessionGoalMutation): string | null {
  if (!('objective' in mutation) || typeof mutation.objective !== 'string') return null;
  const objective = mutation.objective.trim();
  return objective.length > 0 ? objective : null;
}

function requestsUnsupportedMutation(mutation: AgentSessionGoalMutation): boolean {
  return ('status' in mutation && mutation.status !== undefined)
    || ('tokenBudget' in mutation && mutation.tokenBudget !== undefined);
}

function readLiveFailure(value: unknown): AgentSessionGoalMutationResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.ok !== false || typeof record.errorCode !== 'string') return null;
  const failure = SessionGoalControlFailureV1Schema.safeParse(record.goalControlFailure);
  return { status: 'unsupported', diagnostic: diagnostic(record.errorCode),
    ...(failure.success ? { goalControlFailure: failure.data } : {}) };
}

export function createClaudeNativeGoalControl() {
  const liveOperations = new Map<string, ClaudeNativeGoalOperations>();
  let operationOrdinal = 0;
  const pending = (sessionId: string) => ({
    status: 'pending' as const,
    operationId: `claude-goal:${sessionId}:${++operationOrdinal}`,
  });

  const control: AgentSessionGoalControl = {
    async get(context) {
      return {
        status: 'unchanged',
        revision: `claude-goal:${context.session.id}:current`,
      };
    },
    async set(mutation, context) {
      if (requestsUnsupportedMutation(mutation)) {
        return unsupported('claude_goal_mutation_unsupported');
      }
      const objective = readObjective(mutation);
      if (!objective) return unsupported('claude_goal_objective_required');

      if (context.session.activity === 'active') {
        const operations = liveOperations.get(context.session.id);
        if (!operations?.setGoal) return unavailable('claude_goal_live_session_unavailable');
        const result = await operations.setGoal(objective, undefined);
        const failure = readLiveFailure(result);
        return failure ?? pending(context.session.id);
      }

      // Only the live /goal effector can change Claude's objective. The host
      // may explicitly resume and invoke that same control; publishing a badge
      // here would acknowledge a native write that never happened.
      return unsupported('inactive_agent_control_unsupported');
    },
    async clear(context) {
      if (context.session.activity === 'active') {
        const operations = liveOperations.get(context.session.id);
        if (!operations?.clearGoal) return unavailable('claude_goal_live_session_unavailable');
        const result = await operations.clearGoal();
        const failure = readLiveFailure(result);
        return failure ?? pending(context.session.id);
      }

      return unsupported('inactive_agent_control_unsupported');
    },
  };

  return Object.freeze({
    control,
    bind(sessionId: string, operations: ClaudeNativeGoalOperations) {
      liveOperations.set(sessionId, operations);
      return () => {
        if (liveOperations.get(sessionId) === operations) liveOperations.delete(sessionId);
      };
    },
  });
}
