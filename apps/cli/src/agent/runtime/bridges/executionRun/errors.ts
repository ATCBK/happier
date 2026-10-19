import { logger } from '@/ui/logger';
import { sanitizeConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/sanitizeConnectedServiceRuntimeFailureClassification';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { withExecutionRunStartFailureDetails } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { sanitizeSessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { readRuntimeTurnFailureAlreadySurfacedEvent } from '@/agent/runtime/turns/runtimeTurnOperations';
import type { ExecutionRunState } from './executionRunTypes';
import type { AgentRuntimeDiagnosticDataV1 } from '@happier-dev/protocol/runtime/agentRuntimeDiagnosticV1';

/**
 * Preparation precedes fresh Run creation. The refusal keeps the error's own typed code; an error with
 * none gets the fallback code and keeps its message as the reason, so the Action result and the daemon
 * log say why no Run was created instead of only that preparation failed.
 */
export function markExecutionRunStartPreparationFailure(
  error: unknown,
  fallbackCode: 'execution_run_contribution_snapshot_unavailable' | 'execution_run_profile_preparation_failed',
): Error {
  const failure = error instanceof Error ? error : new Error(fallbackCode);
  const details = 'details' in failure ? failure.details : undefined;
  const typedCode = readRpcErrorCode(error) ?? readExecutionRunErrorCode(error);
  const code = typedCode ?? fallbackCode;
  const reason = failure.message.trim() || null;
  logger.warn('[EXECUTION RUN] Start preparation failed', { code, ...(reason ? { reason } : {}) });
  return Object.assign(failure, {
    rpcErrorCode: code,
    ...(!typedCode && reason ? { executionRunStartPreparationReason: reason } : {}),
    details: withExecutionRunStartFailureDetails(details, 'noRunCreated'),
  });
}

/** The reason an untyped preparation failure carried, for the Action result's human text. */
export function readExecutionRunStartPreparationReason(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const reason = (error as { executionRunStartPreparationReason?: unknown }).executionRunStartPreparationReason;
  return typeof reason === 'string' && reason ? reason : null;
}

/** Provider evidence that the initial input was definitively refused before work. */
export class ExecutionRunRejectedStartError extends Error {
  readonly executionRunErrorCode = 'connected_service_model_start_rejected';
  constructor(readonly classification: ConnectedServiceRuntimeFailureClassification) {
    super(`Connected account rejected model '${classification.providerLimitId}' before Run start`);
    this.name = 'ExecutionRunRejectedStartError';
  }
}

export function readExecutionRunRejectedStartDiagnostic(diagnostic: unknown): ExecutionRunRejectedStartError | null {
  if (!diagnostic || typeof diagnostic !== 'object' || !('code' in diagnostic)
    || diagnostic.code !== 'connected_service_model_start_rejected'
    || !('details' in diagnostic) || !diagnostic.details || typeof diagnostic.details !== 'object'
    || !('runtimeAuthClassification' in diagnostic.details)) return null;
  const classification = sanitizeConnectedServiceRuntimeFailureClassification(diagnostic.details.runtimeAuthClassification);
  if (!classification || classification.kind !== 'plan' || classification.limitCategory !== 'plan_invalid'
    || classification.quotaScope !== 'model' || !classification.providerLimitId) return null;
  return new ExecutionRunRejectedStartError(classification);
}

export type ExecutionRunTimeoutError = Error & Readonly<{
  executionRunErrorCode: string;
  livenessProbe?: unknown;
}>;

export function createExecutionRunTimeoutError(params: Readonly<{
  timeoutMs: number;
  errorCode: string;
  livenessProbe: unknown;
}>): ExecutionRunTimeoutError {
  const error = new Error(`Timed out after ${params.timeoutMs}ms`) as ExecutionRunTimeoutError;
  Object.assign(error, {
    executionRunErrorCode: params.errorCode,
    livenessProbe: params.livenessProbe,
  });
  return error;
}

export function readExecutionRunErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const carrier = error as { executionRunErrorCode?: unknown; code?: unknown };
  for (const code of [carrier.executionRunErrorCode, readRpcErrorCode(error), carrier.code,
    readRuntimeTurnFailureAlreadySurfacedEvent(error)?.diagnostic.code]) {
    if (typeof code === 'string' && code.trim()) return code.trim();
  }
  return null;
}

export function readExecutionRunErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error
    && typeof error.message === 'string' && error.message.trim()) return error.message;
  return 'Execution failed';
}

/** Reuse the runtime's typed failure evidence; untyped errors do not acquire a guessed issue. */
export function readExecutionRunRuntimeIssue(error: unknown): NonNullable<ExecutionRunState['error']>['runtimeIssueV1'] {
  if (!error || typeof error !== 'object') return undefined;
  const issue = sanitizeSessionRuntimeIssueV1('runtimeIssueV1' in error ? error.runtimeIssueV1 : undefined);
  if (issue) return issue;
  const event = readRuntimeTurnFailureAlreadySurfacedEvent(error);
  return event ? classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: event.diagnostic,
    occurredAt: event.emittedAtMs, agentTurnId: event.turnId }) : undefined;
}

export function projectExecutionRunError(error: unknown): NonNullable<ExecutionRunState['error']> & Readonly<{ message: string }> {
  const runtimeIssueV1 = readExecutionRunRuntimeIssue(error);
  return { code: readExecutionRunErrorCode(error) ?? 'execution_run_failed', message: readExecutionRunErrorMessage(error),
    ...(runtimeIssueV1 ? { runtimeIssueV1 } : {}) };
}

/** Keep the typed cause across a redaction boundary without copying private details. */
export function sanitizeExecutionRunError(error: unknown, sanitize: (value: string) => string): Error & { code?: string } {
  const sanitized = new Error(sanitize(typeof error === 'string' ? error : readExecutionRunErrorMessage(error)));
  if (error instanceof Error) sanitized.name = error.name;
  const code = readExecutionRunErrorCode(error);
  const runtimeIssueV1 = readExecutionRunRuntimeIssue(error);
  return Object.assign(sanitized, code ? { code } : {}, runtimeIssueV1 ? { runtimeIssueV1: {
    ...runtimeIssueV1,
    ...(runtimeIssueV1.sanitizedPreview ? { sanitizedPreview: sanitize(runtimeIssueV1.sanitizedPreview) } : {}),
  } } : {});
}

export function createExecutionRunCodedError(code: string, message: string): Error {
  const error = new Error(message);
  Object.assign(error, { executionRunErrorCode: code });
  return error;
}

export function createExecutionRunDiagnosticError(diagnostic: AgentRuntimeDiagnosticDataV1, occurredAt: number, agentId?: string): Error {
  return Object.assign(createExecutionRunCodedError(diagnostic.code, diagnostic.message ?? diagnostic.code), {
    runtimeIssueV1: classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error: diagnostic, occurredAt, provider: agentId }),
  });
}

export function isExecutionRunTimeoutError(error: unknown): error is ExecutionRunTimeoutError {
  const code = readExecutionRunErrorCode(error);
  return code === 'provider_inactivity_timeout';
}
