import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

/** Validate the real producer's payload before an executor can turn drift into invalid_action_output. */
export function assertActionOutputContract(actionId: ActionId, output: unknown): void {
    const schema = getActionSpec(actionId).outputSchema;
    if (!schema) throw new Error(`Action ${actionId} has no registered output schema`);
    // Keep the registry's exact parser and its field-level errors; no test-owned schema or projection.
    schema.parse(output);
}
