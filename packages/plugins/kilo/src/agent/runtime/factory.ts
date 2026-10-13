import type {
  AgentAcpRuntimeOptions,
  AgentRuntimeFactory,
  AgentSessionConfigurationSnapshot,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildKiloAcpEnv, buildKiloAcpToolNameResolver } from '../acp/callbacks.js';
import { KILO_ACP_RUNTIME_DEFINITION } from '../acp/definition.js';
import { KILO_ACP_COMMAND } from '../acp/command.js';

function createKiloAcpOptions(
  request: Pick<AgentSessionOpenRequest, 'launchEnvironment' | 'mcpServers' | 'mcpToolPolicy'> & Readonly<{
    configuration?: AgentSessionConfigurationSnapshot;
  }>,
): AgentAcpRuntimeOptions {
  if (!request.configuration) throw new Error('Kilo requires the host-projected Agent session configuration');
  return {
    transport: {
      kind: 'stdio',
      executable: { kind: 'systemTool', id: KILO_ACP_COMMAND.toolId },
      args: [...KILO_ACP_COMMAND.args],
      env: buildKiloAcpEnv({
        launchEnvironment: request.launchEnvironment,
        permissionIntent: request.configuration.permissionIntent.value,
        mcpToolPolicy: request.mcpToolPolicy,
      }),
    },
    definition: { ...KILO_ACP_RUNTIME_DEFINITION, toolNameResolver: buildKiloAcpToolNameResolver(request) },
  };
}

export const createKiloAgentRuntime: AgentRuntimeFactory = () => ({
  sessions: {
    open(request, context) {
      return context.protocols.acp.open(request, createKiloAcpOptions(request));
    },
    executionRunContextV1: {
      open: (request, context) => context.protocols.acp.openExecutionRunV1(
        request,
        createKiloAcpOptions(request),
      ),
    },
  },
});
