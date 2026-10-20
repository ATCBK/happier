import { PUBLIC_ACTION_INPUT_SCHEMAS, PUBLIC_ACTION_OUTPUT_SCHEMAS,
  type ActionExecutionPlacement } from '@happier-dev/protocol/actions/actionSpecs';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ActionExecuteResult } from '@happier-dev/protocol';

/** Reads the incumbent descriptor projection; it does not interpret executable declarations. */
export async function readContributedActionExecutionPlacement(input: unknown,
  readSpec: (request: Readonly<{ id: string }>) => Promise<ActionExecuteResult>): Promise<
  | null
  | Readonly<{ ok: true; placement: ActionExecutionPlacement }>
  | Readonly<{ ok: false; failure: ActionExecuteResult }>
> {
  const invocation = PUBLIC_ACTION_INPUT_SCHEMAS['action.invoke'].safeParse(input);
  if (!invocation.success) return null;
  const id = formatQualifiedPluginActionId(invocation.data.action);
  const outcome = await readSpec({ id });
  if (!outcome.ok) return { ok: false, failure: outcome };
  const descriptor = PUBLIC_ACTION_OUTPUT_SCHEMAS['action.spec.get'].safeParse(outcome.result);
  if (!descriptor.success || descriptor.data.actionSpec.id !== id || !descriptor.data.actionSpec.executionPlacement) {
    return { ok: false, failure: { ok: false, errorCode: 'plugin_action_execution_placement_unavailable',
      error: 'plugin_action_execution_placement_unavailable' } };
  }
  return { ok: true, placement: descriptor.data.actionSpec.executionPlacement };
}
