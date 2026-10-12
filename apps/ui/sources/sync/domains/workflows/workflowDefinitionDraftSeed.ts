import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { WorkflowStarterSessionTarget } from '@happier-dev/protocol/workflows/builtins/examples';

import { readWorkflowEditorDraftSeed, storeWorkflowEditorDraftSeed } from './workflowEditorDraftSeed';

/** Unsaved authoring copy only: no Artifact identity or grants. Source selection is not placement. */
export type WorkflowDefinitionDraftSeed = Readonly<{
    name: string;
    description?: string;
    definition: WorkflowDefinitionV1;
    trigger?: AutomationTriggerDefinitionInput;
    sessionTarget?: WorkflowStarterSessionTarget;
}>;

const WORKFLOW_DEFINITION_DRAFT_SEED_KIND = 'workflow-definition-draft-seed';

export function storeWorkflowDefinitionDraftSeed(seed: WorkflowDefinitionDraftSeed): string {
    return storeWorkflowEditorDraftSeed(WORKFLOW_DEFINITION_DRAFT_SEED_KIND, seed);
}

export function readWorkflowDefinitionDraftSeed(id: string): WorkflowDefinitionDraftSeed | null {
    return readWorkflowEditorDraftSeed(WORKFLOW_DEFINITION_DRAFT_SEED_KIND, id);
}
