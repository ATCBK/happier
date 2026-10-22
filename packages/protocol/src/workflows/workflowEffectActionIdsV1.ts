/** Id-only dependency: Action census construction must not evaluate Workflow schemas. */
export const WORKFLOW_EFFECT_ACTION_IDS_V1 = ['webhooks.call', 'machines.command.run', 'workflow.discussion.round.project'] as const;
export type WorkflowEffectActionIdV1 = typeof WORKFLOW_EFFECT_ACTION_IDS_V1[number];
