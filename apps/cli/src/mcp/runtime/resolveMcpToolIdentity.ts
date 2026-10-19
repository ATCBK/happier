import { parseMcpToolWireNameV1, type ResolvedMcpToolIdentityV1 } from '@happier-dev/protocol/mcp/servers/tools/mcpToolIdentityV1';
import { resolveMcpToolDecisionV1 } from '@happier-dev/protocol/mcp/servers/tools/resolveMcpToolDecisionV1';
import type { AgentPermissionIntentV1 } from '@happier-dev/protocol/runtime/permissionIntentV1';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import type { McpServerIdentity } from './assignMcpWireNames';

export type McpToolPolicyContext = Readonly<{
  catalog: McpServerCatalogSnapshotV1 | null;
  mcpServerIdentities: Readonly<Record<string, McpServerIdentity>>;
  /** The captured catalog owner's existing demand/in-flight admission. */
  prepareCatalog?: () => Promise<unknown>;
}>;

/** Await known loading authority before an interactive request is published. */
export function prepareMcpToolCatalog(input: Readonly<{
  toolName: string; context: McpToolPolicyContext | null | undefined;
}>): Promise<void> | undefined {
  const context = input.context;
  if (!context?.prepareCatalog || (context.catalog && context.catalog.status !== 'loading')) return;
  if (!parseMcpToolWireNameV1(input.toolName, new Set(Object.keys(context.mcpServerIdentities)))) return;
  // Failed admission retains the ordinary unresolved-identity Ask fallback.
  // The hydration owner supplies currentness, failure state and shared work.
  return context.prepareCatalog().then(() => undefined, () => undefined);
}

/** Resolves host-owned wire identity against the current admitted Account row. */
export function resolveMcpToolIdentity(input: Readonly<{ toolName: string; permissionMode: AgentPermissionIntentV1; context: McpToolPolicyContext | null | undefined }>): ResolvedMcpToolIdentityV1 | null {
  if (!input.context) return null;
  const identity = parseMcpToolWireNameV1(input.toolName, new Set(Object.keys(input.context.mcpServerIdentities)));
  if (!identity) return null;
  const bound = input.context.mcpServerIdentities[identity.server]!;
  const snapshot = input.context.catalog;
  const catalog = snapshot?.status === 'ready' && snapshot.authority === 'active' ? snapshot.catalog : null;
  const server = catalog?.servers.find(server => server.id === bound.serverId);
  // An admitted wire key alone cannot authorize a persistent tool setting.
  // Missing current catalog authority leaves the native request with ordinary
  // interactive approval, without a resolved identity for "Always allow".
  if (!catalog || (!server && !bound.plugin)) return null;
  const settings = bound.plugin ? catalog?.pluginServers?.[bound.serverId] : server;
  const tool = settings?.toolsSnapshot?.tools.find(tool => tool.name === identity.tool);
  return { ...identity, item: { serverId: bound.serverId, ...(bound.plugin ? { plugin: bound.plugin } : {}) },
    serverTitle: server?.title ?? bound.serverTitle,
    ...(tool?.title ? { toolTitle: tool.title } : {}), ...(tool?.annotations ? { annotations: tool.annotations } : {}),
    decision: resolveMcpToolDecisionV1({ policy: settings?.tools, toolName: identity.tool, annotations: tool?.annotations, permissionMode: input.permissionMode }),
  };
}
