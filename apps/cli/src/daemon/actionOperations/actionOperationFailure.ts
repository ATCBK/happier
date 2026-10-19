import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

/** Project a boundary exception without serializing its request, response or cause. */
export async function projectActionOperationFailure(error: unknown, fallback: string): Promise<ActionExecuteFailure> {
  const errorCode = readRpcErrorCode(error)
    ?? (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : fallback);
  const [{ ActionOperationFailureV1Schema }, { redactBugReportSensitiveText }] = await Promise.all([
    import('@happier-dev/protocol/actions/operations/v1'), import('@happier-dev/protocol/bugs/reports/redaction'),
  ]);
  const diagnostic = ActionOperationFailureV1Schema.safeParse({ errorCode,
    error: error instanceof Error && error.message.trim() ? redactBugReportSensitiveText(error.message) : errorCode });
  return { ok: false, errorCode, error: diagnostic.success ? diagnostic.data.error
    : errorCode === 'workspace_sync_prepare_failed' ? 'Workspace preparation failed; the diagnostic exceeds the operation error format' : errorCode };
}
