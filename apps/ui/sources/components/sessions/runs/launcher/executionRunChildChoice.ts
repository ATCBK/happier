import { ExecutionRunStartFailureDetailsV1Schema, readExecutionRunStartRunCreation,
    type ExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProviderBoundModelRef, TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol';

/** A chooser is permission for a fresh attempt, not a retry of an unknown-effect start. */
export function readExecutionRunChildChoice(result: ActionExecuteResult): ExecutionRunChildChoiceV1 | null {
    const details = !result.ok ? ExecutionRunStartFailureDetailsV1Schema.safeParse(result.details) : null;
    if (!result.ok && result.errorCode === 'execution_run_child_choice_required' && details?.success
        && details.data.childChoice && readExecutionRunStartRunCreation(details.data) === 'noRunCreated') {
        return details.data.childChoice;
    }
    return null;
}

export type ExecutionRunChildSelection = 'agentDefault' | ProviderBoundModelRef
    | Readonly<{ teamCredentialModel: TeamCredentialProviderModelSelectionV1 }>;

/** A fresh start input carrying exactly one child choice: the Agent's Account default or an exact model. */
export function applyExecutionRunChildSelection<T extends Record<string, unknown>>(input: T, selection: ExecutionRunChildSelection): Record<string, unknown> {
    const { modelId: _modelId, modelSelection: _modelSelection, teamCredentialModel: _team, teamCredentialSessionBindingConsent: _consent,
        connectedServices: _connected, connectedServicesDefaultServiceIds: _defaults, childSelection: _child, ...rest } = input;
    return selection === 'agentDefault' ? { ...rest, childSelection: 'agentDefault' }
        : 'teamCredentialModel' in selection ? { ...rest, teamCredentialModel: selection.teamCredentialModel }
        : { ...rest, modelSelection: selection };
}
