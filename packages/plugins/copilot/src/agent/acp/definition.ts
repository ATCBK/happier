import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';

import { COPILOT_ACP_STDERR_RULES, COPILOT_ACP_TIMEOUTS, COPILOT_ACP_TOOL_NAME_INFERENCE } from './transport.js';
import { COPILOT_ACP_MODEL_CONTROLS } from './modelControls.js';

export const COPILOT_ACP_RUNTIME_DEFINITION = Object.freeze({
  modelConfigOptionId: 'model',
  models: COPILOT_ACP_MODEL_CONTROLS,
  timeouts: COPILOT_ACP_TIMEOUTS,
  toolNameInference: COPILOT_ACP_TOOL_NAME_INFERENCE,
  stderrRules: COPILOT_ACP_STDERR_RULES,
  mcp: { policy: 'pass_through' },
  skills: { sessionDelivery: {
    kind: 'env_path_list', envKey: 'COPILOT_SKILLS_DIRS', separator: ',', value: 'skills_root',
  } },
} satisfies NonNullable<AgentAcpRuntimeOptions['definition']>);
