import type { AgentRuntimeFactory } from '@happier-dev/plugin-sdk/agents/runtime';

export { codexExternalSessionsContribution } from '../surfaces/sessions/external/contribution.js';

export const createCodexAgentRuntime: AgentRuntimeFactory = async context => {
  const { createCodexAgentRuntime } = await import('./engine.js');
  return await createCodexAgentRuntime(context);
};
