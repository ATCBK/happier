import type {
  AgentLaunchEnvironment,
  AgentPermissionIntent,
  AgentSessionOpenRequest,
  AgentAcpToolNameResolver,
} from '@happier-dev/plugin-sdk/agents/runtime';

import { buildKiloOpenCodePermissionEnv, sanitizeKiloMcpName } from '../permissions/kiloPermissionPolicy.js';

export function buildKiloAcpToolNameResolver(
  request: Pick<AgentSessionOpenRequest, 'mcpServers' | 'mcpToolPolicy'>,
): AgentAcpToolNameResolver {
  const keys = Object.keys(request.mcpServers ?? {}).sort((a, b) => sanitizeKiloMcpName(b).length - sanitizeKiloMcpName(a).length);
  return ({ toolName, input }) => {
    const acp = input._acp !== null && typeof input._acp === 'object' ? input._acp as Readonly<Record<string, unknown>> : undefined;
    for (const name of [toolName, acp?.title]) {
      if (typeof name !== 'string') continue;
      const key = keys.find((key) => name.startsWith(`${sanitizeKiloMcpName(key)}_`));
      if (!key) continue;
      const suffix = name.slice(sanitizeKiloMcpName(key).length + 1);
      if (!suffix) continue;
      const tools = Object.prototype.hasOwnProperty.call(request.mcpToolPolicy ?? {}, key)
        ? Object.keys(request.mcpToolPolicy![key]!.tools).filter((tool) => sanitizeKiloMcpName(tool) === suffix)
        : [];
      if (tools.length > 1) continue;
      return `mcp__${key}__${tools[0] ?? suffix}`;
    }
    return toolName;
  };
}

export function buildKiloAcpEnv(params: Readonly<{
  launchEnvironment?: AgentLaunchEnvironment;
  permissionIntent: AgentPermissionIntent | null;
  mcpToolPolicy?: AgentSessionOpenRequest['mcpToolPolicy'];
}>): Readonly<Record<string, string>> {
  return buildKiloOpenCodePermissionEnv({
    env: params.launchEnvironment?.values,
    permissionIntent: params.permissionIntent,
    mcpToolPolicy: params.mcpToolPolicy,
  });
}
