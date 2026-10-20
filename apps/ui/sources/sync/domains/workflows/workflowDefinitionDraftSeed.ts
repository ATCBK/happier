import type { WorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/workflowV1';
import type { AutomationTriggerDefinitionInput } from '@happier-dev/protocol/automations/automationTriggerDefinition';
import type { WorkflowStarterSessionTarget } from '@happier-dev/protocol/workflows/builtins/examples';

import { readWorkflowEditorDraftSeed, storeWorkflowEditorDraftSeed } from './workflowEditorDraftSeed';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

/** Unsaved authoring copy only: no Artifact identity or grants. Source selection is not placement. */
export type WorkflowDefinitionDraftSeed = Readonly<{
    name: string;
    description?: string;
    definition: WorkflowDefinitionV1;
    trigger?: AutomationTriggerDefinitionInput;
    sessionTarget?: WorkflowStarterSessionTarget;
}>;

const WORKFLOW_DEFINITION_DRAFT_SEED_KIND = 'workflow-definition-draft-seed';

export function storeWorkflowDefinitionDraftSeed(seed: WorkflowDefinitionDraftSeed, accountLifetime?: ServerAccountScopeLifetime | null): string {
    return storeWorkflowEditorDraftSeed(WORKFLOW_DEFINITION_DRAFT_SEED_KIND, seed, accountLifetime);
}

export function readWorkflowDefinitionDraftSeed(id: string, scope?: ServerAccountScope | null): WorkflowDefinitionDraftSeed | null {
    return readWorkflowEditorDraftSeed(WORKFLOW_DEFINITION_DRAFT_SEED_KIND, id, scope);
}
