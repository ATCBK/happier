import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

export { claudeExternalSessionsContribution } from '../surfaces/sessions/external/contribution.js';

export const createClaudeAgentRuntime: AgentRuntimeFactory = async context => {
  const { createClaudeAgentRuntime } = await import('./nativeRuntime.js');
  return await createClaudeAgentRuntime(context);
};
