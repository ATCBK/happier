import { logger } from '@/ui/logger';
import type { ActionStartDiagnosticV1 } from '@happier-dev/protocol/actions/executor/actionStartDiagnostics';

function isTracedRequest(actionId: unknown, rootRequestId: unknown): boolean {
  return (actionId === 'session.stop' || actionId === 'session.status.get' || actionId === 'plugins.list' || actionId === 'action.invoke'
      || process.env.HAPPIER_WEB_LATENCY_TRACE === '1'
        && (actionId === 'approval.request.decide' || actionId === 'projects.script.run' || actionId === 'projects.compute.exec'
          || actionId === 'machines.provisioners.list' || actionId === 'machines.provisioners.check' || actionId === 'machines.provisioners.options'))
    && typeof rootRequestId === 'string'
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(rootRequestId);
}

/** Same UUID-qualified, content-free trace for host and contributed Action work. */
export async function runTracedExternalActionStage<T>(actionId: string, rootRequestId: unknown, stage: string,
  operation: () => T | Promise<T>): Promise<T> {
  // Socket RPC owns this prefix; retain its UUID so completion records join.
  const requestId = typeof rootRequestId === 'string' ? rootRequestId.replace(/^rpc_/u, '') : rootRequestId;
  traceExternalActionStage(actionId, requestId, `${stage}.begin`);
  try { return await operation(); }
  finally { traceExternalActionStage(actionId, requestId, `${stage}.end`); }
}

/** Correlates diagnosed admission paths without caller content. */
export function traceExternalActionStage(actionId: unknown, rootRequestId: unknown, stage: string, transportRequestId?: string,
  diagnostic?: Pick<ActionStartDiagnosticV1, 'phase' | 'elapsedMs'>): void {
  if (!isTracedRequest(actionId, rootRequestId)) return;
  try {
    logger.warnLocalFile('[external-action-stage]', { actionId, rootRequestId, stage,
      ...(diagnostic ? { phase: diagnostic.phase,
        ...(diagnostic.elapsedMs !== undefined ? { elapsedMs: diagnostic.elapsedMs } : {}) } : {}),
      ...(transportRequestId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(transportRequestId)
        ? { transportRequestId } : {}) });
  } catch { /* Diagnostics cannot change the Action outcome. */ }
}

export function createExternalActionStartDiagnosticRecorder(actionId: unknown, rootRequestId: unknown,
  transportRequestId?: string): ((event: ActionStartDiagnosticV1) => void) | undefined {
  if (!isTracedRequest(actionId, rootRequestId)) return undefined;
  return event => traceExternalActionStage(actionId, rootRequestId, 'action_execution.phase', transportRequestId,
    { phase: event.phase, ...(event.elapsedMs !== undefined ? { elapsedMs: event.elapsedMs } : {}) });
}

export type ExternalActionPhaseFailure = Readonly<{
  ok: false;
  phase: string;
  errorClass: string;
  message: string;
}>;

/** Private diagnostics must not serialize a thrown value, even a Zod or HTTP Error. */
export function refuseExternalActionPhase(phase: string, machineId: string, error?: unknown): ExternalActionPhaseFailure {
  let errorClass = error === undefined ? 'PhaseRefused' : 'UnknownThrownValue';
  let message = error === undefined ? 'External Action phase refused' : 'External Action phase threw (details redacted)';
  // Preserve the useful Mini-migration discriminator without retaining an
  // arbitrary expression, path, credential or value from a runtime message.
  try {
    errorClass = error === undefined ? 'PhaseRefused'
      : error instanceof TypeError ? 'TypeError'
      : error instanceof RangeError ? 'RangeError'
      : error instanceof SyntaxError ? 'SyntaxError'
      : error instanceof Error ? 'Error' : 'UnknownThrownValue';
    if (error && typeof error === 'object' && 'name' in error) {
      const name = error.name;
      if (name === 'ZodError' || name === '$ZodError' || name === 'AxiosError' || name === 'AbortError') {
        errorClass = name;
      }
    }
    if (error instanceof TypeError) {
      const method = /\.(optional|nullable|extend|merge|partial|required|passthrough|strict|pick|omit|refine|transform|default) is not a function$/u.exec(error.message)?.[1];
      if (method) message = `Schema .${method} is not a function`;
    }
  } catch { /* Thrown values can have hostile prototype or message accessors. */ }
  const failure = { ok: false as const, phase, errorClass, message };
  // File-only: no terminal output or remote diagnostic payload. Logging cannot
  // change the existing public refusal if the filesystem is unavailable.
  try { logger.warnLocalFile('[external-action-phase]', { machineId, phase, errorClass, message }); } catch { /* Best effort. */ }
  return failure;
}

/** Keep a masked boundary failure typed until its owner maps it to the public result. */
export async function runExternalActionPhase<T>(phase: string, machineId: string, operation: () => T | Promise<T>): Promise<
  Readonly<{ ok: true; value: NonNullable<T> }> | ExternalActionPhaseFailure
> {
  try {
    const value = await operation();
    return value === null || value === undefined || value === false
      ? refuseExternalActionPhase(phase, machineId)
      : { ok: true, value };
  } catch (error) { return refuseExternalActionPhase(phase, machineId, error); }
}
