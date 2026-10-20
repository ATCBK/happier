export const PROMPT_INVOCATION_ACTION_IDS = ['prompts.invocation.create', 'prompts.invocation.update', 'prompts.invocation.delete'] as const;
export type PromptInvocationActionId = typeof PROMPT_INVOCATION_ACTION_IDS[number];

export function isPromptInvocationActionId(id: string): id is PromptInvocationActionId {
  return (PROMPT_INVOCATION_ACTION_IDS as readonly string[]).includes(id);
}
