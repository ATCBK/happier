import type { AgentState } from '../types';
import { cloneStringKeyedRecordToNullProto } from './agentStateRecords';
import { deepEqual } from '@/utils/deterministicJson';
import { hasPermissionResponseClaimV1 } from '@/agent/permissions/agentStateRequestStore';
import { logger } from '@/ui/logger';

type PendingRequest = NonNullable<AgentState['requests']>[string];
type CompletedRequest = NonNullable<AgentState['completedRequests']>[string];

type PendingIdentity = Readonly<Pick<PendingRequest, 'tool' | 'arguments' | 'createdAt'>> & Readonly<{
  kind?: string;
  source?: string;
}>;

type CompletionOutcome = Readonly<{
  completed: CompletedRequest;
  expectedRequest: PendingIdentity | null;
  removeRequest: boolean;
}>;

function getPendingIdentity(request: PendingRequest | undefined): PendingIdentity | null {
  if (!request) return null;
  const value = request as PendingRequest & { source?: unknown };
  return {
    tool: value.tool,
    arguments: value.arguments,
    createdAt: value.createdAt,
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
  };
}

function samePendingIdentity(request: PendingRequest, identity: PendingIdentity): boolean {
  const current = getPendingIdentity(request);
  return current !== null
    && current.tool === identity.tool
    && current.createdAt === identity.createdAt
    && deepEqual(current.arguments, identity.arguments)
    && current.kind === identity.kind
    && current.source === identity.source;
}

function isFinalizedCompletion(value: unknown): value is CompletedRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const status = (value as { status?: unknown }).status;
  return status === 'approved' || status === 'denied' || status === 'canceled';
}

function captureOutcomes(before: AgentState, after: AgentState): Map<string, CompletionOutcome> {
  const outcomes = new Map<string, CompletionOutcome>();
  const oldCompleted = before.completedRequests ?? {};
  const nextCompleted = after.completedRequests ?? {};
  for (const [requestId, completed] of Object.entries(nextCompleted)) {
    if (!isFinalizedCompletion(completed) || deepEqual(oldCompleted[requestId], completed)) continue;
    const oldRequest = before.requests?.[requestId];
    const nextRequest = after.requests?.[requestId];
    outcomes.set(requestId, {
      completed,
      expectedRequest: getPendingIdentity(oldRequest),
      removeRequest: oldRequest !== undefined && nextRequest === undefined,
    });
  }
  return outcomes;
}

function applyOutcome(state: AgentState, requestId: string, outcome: CompletionOutcome): AgentState {
  const completedRequests = cloneStringKeyedRecordToNullProto<CompletedRequest>(state.completedRequests);
  const requests = cloneStringKeyedRecordToNullProto<PendingRequest>(state.requests);
  if (Object.prototype.hasOwnProperty.call(completedRequests, requestId)) return state;

  const currentRequest = requests[requestId];
  if (outcome.expectedRequest === null) {
    if (currentRequest !== undefined || outcome.removeRequest) return state;
  } else if (!currentRequest || hasPermissionResponseClaimV1(currentRequest) || !samePendingIdentity(currentRequest, outcome.expectedRequest)) {
    return state;
  }

  completedRequests[requestId] = outcome.completed;
  if (outcome.removeRequest) delete requests[requestId];
  return {
    ...state,
    completedRequests,
    ...(outcome.removeRequest ? { requests } : {}),
  };
}

export class AgentStateCompletionRecovery {
  private readonly pending = new Map<string, CompletionOutcome>();

  constructor(private readonly getSnapshot: () => AgentState | null) {}

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  async runUpdate(params: Readonly<{
    handler: (state: AgentState) => AgentState;
    write: (handler: (state: AgentState) => AgentState) => Promise<void>;
    retainPermissionCompletionsOnFailure?: boolean;
  }>): Promise<void> {
    const replayed = new Map(this.pending);
    let captured = new Map<string, CompletionOutcome>();
    let handlerInvoked = false;
    const wrappedHandler = (state: AgentState): AgentState => {
      captured = new Map();
      let next = state;
      for (const [requestId, outcome] of replayed) {
        next = applyOutcome(next, requestId, outcome);
      }
      handlerInvoked = true;
      next = params.handler(next);
      if (params.retainPermissionCompletionsOnFailure) {
        captured = captureOutcomes(state, next);
      }
      return next;
    };

    try {
      await params.write(wrappedHandler);
      for (const [requestId, outcome] of replayed) {
        if (this.pending.get(requestId) === outcome) this.pending.delete(requestId);
      }
    } catch (error) {
      if (params.retainPermissionCompletionsOnFailure) {
        if (!handlerInvoked) {
          const snapshot = this.getSnapshot() ?? {};
          try {
            captured = captureOutcomes(snapshot, params.handler(snapshot));
          } catch {
            logger.infoFile('[API] session_permission_completion_capture_failed', {
              phase: 'terminal_failure',
              operation: 'capture-agent-state-completion',
            });
          }
        }
        for (const [requestId, outcome] of captured) this.pending.set(requestId, outcome);
      }
      throw error;
    }
  }
}
