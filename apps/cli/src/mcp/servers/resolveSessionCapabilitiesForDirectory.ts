import { resolveSessionCapabilitiesV1, type ResolveSessionCapabilitiesV1Result } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { projectManagedMcpSelectionV1, type ManagedMcpSelectionProjectionV1 } from '@happier-dev/protocol/mcp/servers/previewV1';
import type { McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { ReachContextV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import { createRealpathNormalizer } from './createRealpathNormalizer';

/** Real filesystem comparison at the machine boundary; persisted roots retain their spelling. */
export function resolveSessionCapabilitiesForDirectory(params: Readonly<{
  settings: McpServersSettingsV1; machineId: string; directory: string | null;
  agentId?: string | null; projectKey?: string | null; machinePlatform?: ReachContextV1['machinePlatform'];
  selection?: SessionCapabilitySelectionV1 | null; agentAcceptsUserMcp?: boolean;
}>): ResolveSessionCapabilitiesV1Result & ManagedMcpSelectionProjectionV1 {
  const normalizePath = createRealpathNormalizer();
  const context: ReachContextV1 = { machineId: params.machineId, directory: params.directory === null ? null : normalizePath(params.directory),
    machinePlatform: params.machinePlatform ?? (process.platform === 'win32' ? 'win32' : 'posix'),
    projectKey: params.projectKey ?? null, agentId: params.agentId ?? null };
  const settings = { ...params.settings,
    bindings: params.settings.bindings.map(rule => rule.target.t === 'workspace'
      ? { ...rule, target: { ...rule.target, workspaceRoot: normalizePath(rule.target.workspaceRoot) } } : rule),
    servers: params.settings.servers.map(server => server.configOverrides ? { ...server, configOverrides: server.configOverrides.map(override =>
      override.target.t === 'workspace' ? { ...override, target: { ...override.target, workspaceRoot: normalizePath(override.target.workspaceRoot) } } : override) } : server),
  };
  const result = resolveSessionCapabilitiesV1({ context, mcp: settings, skills: null, selection: params.selection ?? {},
    // A neutral machine projection has no Agent; named Agents supply their declared fact.
    agentAcceptsUserMcp: params.agentAcceptsUserMcp ?? params.agentId == null });
  return { ...result, ...projectManagedMcpSelectionV1(result, { settings, context, selection: params.selection?.mcp }) };
}
