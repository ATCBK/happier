import type { McpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { projectMcpToolLaunchPolicyV1, type McpToolLaunchPolicyV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import type { AgentPermissionIntentV1 } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { McpServerIdentity } from './assignMcpWireNames';

export function projectMcpToolLaunchPolicies(input: Readonly<{
  catalog: McpServerCatalogV1; mcpServerIdentities: Readonly<Record<string, McpServerIdentity>>; permissionMode: AgentPermissionIntentV1;
  control?: Readonly<{ off: 'hidden' | 'blocked'; approval: 'native' | 'host' }>;
}>): Readonly<Record<string, McpToolLaunchPolicyV1>> | undefined {
  if (!input.control) return undefined;
  const servers = new Map(input.catalog.servers.map(server => [server.id, server]));
  return Object.fromEntries(Object.entries(input.mcpServerIdentities).filter(([key]) => key !== 'happier').map(([key, identity]) => {
    const server = servers.get(identity.serverId);
    const settings = identity.plugin ? input.catalog.pluginServers?.[identity.serverId] : server;
    const projected = identity.plugin || server ? projectMcpToolLaunchPolicyV1({ policy: settings?.tools, snapshot: settings?.toolsSnapshot, permissionMode: input.permissionMode })
      : { unlisted: 'deny' as const, tools: {} };
    const policy = input.control?.approval === 'host' ? {
      unlisted: projected.unlisted === 'allow' ? 'ask' as const : projected.unlisted,
      tools: Object.fromEntries(Object.entries(projected.tools).map(([name, decision]) => [name, decision === 'allow' ? 'ask' as const : decision])),
    } : projected;
    return [key, policy];
  }));
}
