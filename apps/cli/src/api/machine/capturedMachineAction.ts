import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionId } from '@happier-dev/protocol/actions';

/** Admission belongs to the captured invoker; an acknowledged effect outlives its cancellation or retirement. */
export async function executeCapturedMachineAction<Result>(input: Readonly<{
  actionId: ActionId;
  assertCurrent: () => Promise<void>;
  invoke: (options: Readonly<{ timeoutMs?: null }>) => Promise<Result>;
}>): Promise<Result> {
  const spec = getActionSpec(input.actionId);
  await input.assertCurrent();
  const result = await input.invoke(spec.sideEffectClass === 'read' ? {} : { timeoutMs: null });
  // Reads disclose current facts; effects retain only the actual transport result, never a replay or invented receipt.
  if (spec.sideEffectClass === 'read') await input.assertCurrent();
  return result;
}
