import { ExecutionRunStartFailureDetailsV1Schema, readExecutionRunStartRunCreation,
    type ExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

/** A chooser is permission for a fresh attempt, not a retry of an unknown-effect start. */
export function readExecutionRunChildChoice(result: ActionExecuteResult): ExecutionRunChildChoiceV1 | null {
    const details = !result.ok ? ExecutionRunStartFailureDetailsV1Schema.safeParse(result.details) : null;
    if (!result.ok && result.errorCode === 'execution_run_child_choice_required' && details?.success
        && details.data.childChoice && readExecutionRunStartRunCreation(details.data) === 'noRunCreated') {
        return details.data.childChoice;
    }
    return null;
}
