import type { AgentAcpRuntimeOptions } from '@happier-dev/plugin-sdk/agents/runtime';

import { QWEN_APPROVAL_MODE_BY_PERMISSION_INTENT } from './approvalMode.js';

export const QWEN_ACP_RUNTIME_DEFINITION = Object.freeze({
  modelConfigOptionId: 'model',
  permissionModeMapping: QWEN_APPROVAL_MODE_BY_PERMISSION_INTENT,
  permissionModeArgv: {
    flag: '--approval-mode',
    map: QWEN_APPROVAL_MODE_BY_PERMISSION_INTENT,
  },
  mcp: { policy: 'pass_through' },
  skills: { sessionDelivery: {
    kind: 'defaults_file_env', envKey: 'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
    directoriesKeyPath: ['skills', 'directories'], disabledKeyPath: ['skills', 'disabled'],
  } },
} satisfies NonNullable<AgentAcpRuntimeOptions['definition']>);
