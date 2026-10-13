import type { McpServerConfig } from '@/agent';
import type { McpServerIdentity } from './assignMcpWireNames';
import type { ResolvedSessionMcpServer, ResolvedSessionMcpScope } from '../runtimeTypes';

/** Projects the applied launch set. It performs no rules, catalog or manifest read. */
export function projectResolvedMcpServers(input: Readonly<{
  mcpServers: Readonly<Record<string, McpServerConfig>>;
  identities: Readonly<Record<string, McpServerIdentity>>;
  scope: ResolvedSessionMcpScope;
}>): readonly ResolvedSessionMcpServer[] {
  return Object.keys(input.mcpServers).flatMap(name => {
    const identity = input.identities[name];
    if (!identity) return [];
    return [{ id: identity.serverId, name, title: identity.serverTitle,
      transport: { kind: 'stdio' as const }, scope: input.scope }];
  }).sort((left, right) => left.id.localeCompare(right.id));
}
