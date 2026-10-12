import type { ActionExecuteResult } from './actionExecutionResult.js';
import type { ActionSpec } from './actionSpecs.js';

/** A successful self-retirement can outlive its own authority, but never disclose Account data. */
export function projectKnownAccountAuthorityRetirementReceipt(
  spec: Pick<ActionSpec, 'accountAuthorityRetirementStatuses' | 'outputSchema'>,
  execution: ActionExecuteResult,
): Readonly<{ ok: true; result: Readonly<{ status: string }> }> | null {
  if (!execution.ok || !spec.accountAuthorityRetirementStatuses?.length || !spec.outputSchema) return null;
  try {
    const parsed = spec.outputSchema.safeParse(execution.result);
    if (!parsed.success || !parsed.data || typeof parsed.data !== 'object' || !('status' in parsed.data)) return null;
    const status = parsed.data.status;
    return typeof status === 'string' && spec.accountAuthorityRetirementStatuses.includes(status)
      ? { ok: true, result: { status } }
      : null;
  } catch {
    return null;
  }
}
