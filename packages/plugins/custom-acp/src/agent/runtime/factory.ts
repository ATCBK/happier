import type { AgentAcpRuntimeOptions, AgentRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { PluginError } from '@happier-dev/plugin-sdk';

// The selected Account definition is admitted and materialized by the host ACP
// launch owner. This reference never selects an executable from plugin services.
const OPTIONS: AgentAcpRuntimeOptions = Object.freeze({
  transport: Object.freeze({
    kind: 'stdio',
    executable: Object.freeze({ kind: 'systemTool', id: 'configured-acp' }),
  }),
  definition: Object.freeze({ mcp: Object.freeze({ policy: 'pass_through' }) }),
});

export function createCustomAcpAgentRuntime(): AgentRuntime {
  return {
    sessions: {
      open: (request, context) => context.protocols.acp.open(request, OPTIONS),
      executionRunContextV1: {
        open: (request, context) => context.protocols.acp.openExecutionRunV1(request, OPTIONS),
        openConversation(request, context) {
          if (!context.protocols.acp.openExecutionRunConversationV1) {
            throw new PluginError({ code: 'execution_run_protocol_unsupported',
              message: 'This host does not support retained detached ACP conversations.' });
          }
          return context.protocols.acp.openExecutionRunConversationV1(request, OPTIONS);
        },
      },
    },
  };
}
