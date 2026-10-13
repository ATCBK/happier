import type {
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  OpenCodeRuntimeEvent,
  OpenCodeRuntimeIssue,
  OpenCodeRuntimeScope,
} from './runtimeEvents.js';

export function projectOpenCodeTurnCancellationCause(
  reason: string | undefined,
): Extract<AgentSessionRuntimeEvent, { kind: 'turn-cancelled' }>['cause'] {
  return reason === 'host_shutdown'
    ? 'hostShutdown'
    : reason === 'session_dispose'
      ? 'sessionDispose'
      : reason === 'runtime_recovery'
        ? 'runtimeRecovery'
        : reason === 'user'
          ? 'user'
          : 'providerCancelled';
}

export function projectOpenCodeRuntimeScope(scope: OpenCodeRuntimeScope) {
  return scope.kind === 'session'
    ? { sessionId: scope.sessionId }
    : { executionRunId: scope.executionRunId };
}

export function buildOpenCodeRuntimeIssue(params: Readonly<{
  code: string;
  source: string;
  message?: string | null;
  occurredAt: number;
  usageLimit?: OpenCodeRuntimeIssue['usageLimit'];
  nativeProviderFailure?: OpenCodeRuntimeIssue['nativeProviderFailure'];
}>): OpenCodeRuntimeIssue {
  return {
    v: 1,
    code: params.code,
    source: params.source,
    occurredAt: params.occurredAt,
    agentId: 'opencode',
    sanitizedPreview: params.message ?? null,
    ...(params.usageLimit ? { usageLimit: params.usageLimit } : {}),
    ...(params.nativeProviderFailure ? { nativeProviderFailure: params.nativeProviderFailure } : {}),
  };
}

/** Both native scopes preserve the same normalized provider evidence. */
export function projectOpenCodeRuntimeIssueDiagnostic(issue: OpenCodeRuntimeIssue) {
  return {
    code: issue.code,
    severity: 'error' as const,
    ...(issue.sanitizedPreview ? { message: issue.sanitizedPreview } : {}),
    details: {
      v: issue.v,
      source: issue.source,
      agentId: issue.agentId,
      ...(issue.usageLimit ? { usageLimit: issue.usageLimit } : {}),
      ...(issue.nativeProviderFailure ? { nativeProviderFailure: issue.nativeProviderFailure } : {}),
    },
  };
}

export async function publishOpenCodeRuntimeEvent(
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void,
  event: OpenCodeRuntimeEvent,
): Promise<void> {
  publishRuntimeEvent(event);
}

export async function publishOpenCodeTurnFailed(params: Readonly<{
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void;
  scope: OpenCodeRuntimeScope;
  turnId: string;
  issue: OpenCodeRuntimeIssue;
  emittedAtMs: number;
}>): Promise<void> {
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'turn-failed',
    ...projectOpenCodeRuntimeScope(params.scope),
    turnId: params.turnId,
    emittedAtMs: params.emittedAtMs,
    issue: params.issue,
  });
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'transcript-agent-message-committed',
    ...projectOpenCodeRuntimeScope(params.scope),
    emittedAtMs: params.emittedAtMs,
    agentId: 'opencode',
    localId: `${params.turnId}:turn_failed`,
    body: {
      type: 'turn_failed',
      id: params.turnId,
    },
  });
}

export async function publishOpenCodeTurnCancelled(params: Readonly<{
  publishRuntimeEvent: (event: OpenCodeRuntimeEvent) => void;
  scope: OpenCodeRuntimeScope;
  turnId: string;
  reason?: string;
  emittedAtMs: number;
}>): Promise<void> {
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'turn-cancelled',
    ...projectOpenCodeRuntimeScope(params.scope),
    turnId: params.turnId,
    emittedAtMs: params.emittedAtMs,
    ...(params.reason ? { reason: params.reason } : {}),
  });
  await publishOpenCodeRuntimeEvent(params.publishRuntimeEvent, {
    kind: 'transcript-agent-message-committed',
    ...projectOpenCodeRuntimeScope(params.scope),
    emittedAtMs: params.emittedAtMs,
    agentId: 'opencode',
    localId: `${params.turnId}:turn_cancelled`,
    body: {
      type: 'turn_cancelled',
      id: params.turnId,
    },
  });
}
