import { resolveSessionCapabilitiesV1, type ResolveSessionCapabilitiesV1Result } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { projectManagedMcpSelectionV1, type ManagedMcpSelectionProjectionV1 } from '@happier-dev/protocol/mcp/servers/previewV1';
import type { McpServersSettingsV1 } from '@happier-dev/protocol/mcp/servers/settingsV1';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { ReachContextV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';
import { SessionSkillSelectionV1Schema } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { resolveSessionProjectKey, type SessionProjectPromptStackInput } from '@/workspaces/resolveSessionProjectKey';
import { createRealpathNormalizer } from './createRealpathNormalizer';

type DirectoryCapabilityParams = Readonly<{
  settings: McpServersSettingsV1; machineId: string; directory: string | null;
  agentId?: string | null; projectKey?: string | null; machinePlatform?: ReachContextV1['machinePlatform'];
  selection?: SessionCapabilitySelectionV1 | null; agentAcceptsUserMcp?: boolean;
  skills?: Parameters<typeof resolveSessionCapabilitiesV1>[0]['skills'];
}>;
type SessionProjectInput = Omit<SessionProjectPromptStackInput, 'machineId' | 'directory'>;
export type DirectoryCapabilityResult = ResolveSessionCapabilitiesV1Result & ManagedMcpSelectionProjectionV1
  & Readonly<{ projectKey: string | null }>;

/** Real filesystem comparison and Account Project association at the machine boundary. */
export function resolveSessionCapabilitiesForDirectory(params: DirectoryCapabilityParams & Readonly<{ sessionProject: SessionProjectInput }>): Promise<DirectoryCapabilityResult>;
export function resolveSessionCapabilitiesForDirectory(params: DirectoryCapabilityParams & Readonly<{ sessionProject?: never }>): DirectoryCapabilityResult;
export function resolveSessionCapabilitiesForDirectory(params: DirectoryCapabilityParams & Readonly<{ sessionProject?: SessionProjectInput }>): DirectoryCapabilityResult | Promise<DirectoryCapabilityResult> {
  if (!params.sessionProject) return resolveForContext(params);
  return resolveForSession(params, params.sessionProject);
}

function needsProjectAssociation(params: DirectoryCapabilityParams): boolean {
  const matchesAgent = (agentId: string | undefined) => agentId === undefined || agentId === params.agentId;
  const mcp = SessionMcpSelectionV1Schema.parse(params.selection?.mcp ?? {});
  if ((params.agentAcceptsUserMcp ?? params.agentId == null) && mcp.managedServersEnabled) {
    const receivableIds = new Set(params.settings.servers.filter(server => !mcp.forceExcludeServerIds.includes(server.id)).map(server => server.id));
    if (params.settings.bindings.some(rule => rule.target.t === 'project' && matchesAgent(rule.agentId) && receivableIds.has(rule.serverId))) return true;
  }
  const skills = SessionSkillSelectionV1Schema.parse(params.selection?.skills ?? {});
  const receivableIds = new Set(params.skills?.items.filter(item => !skills.forceExcludeSkillIds.includes(item.skillId)).map(item => item.skillId));
  return params.skills?.rules.some(rule => rule.target.t === 'project' && matchesAgent(rule.agentId) && receivableIds.has(rule.skillId)) ?? false;
}

async function resolveForSession(params: DirectoryCapabilityParams, sessionProject: SessionProjectInput): Promise<DirectoryCapabilityResult> {
  sessionProject.signal?.throwIfAborted();
  if (params.projectKey !== undefined || !needsProjectAssociation(params)) return resolveForContext(params);
  const project = await resolveSessionProjectKey({ ...sessionProject, machineId: params.machineId,
    ...(params.directory === null ? {} : { directory: params.directory }) });
  if (project.kind === 'pending') throw Object.assign(new Error(project.reason), {
    code: 'preparation_pending', status: 'preparation_pending', reason: project.reason,
  });
  return resolveForContext({ ...params, projectKey: project.kind === 'resolved' ? project.projectKey : null });
}

function resolveForContext(params: DirectoryCapabilityParams): DirectoryCapabilityResult {
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
  const result = resolveSessionCapabilitiesV1({ context, mcp: settings, skills: params.skills ?? null, selection: params.selection ?? {},
    // A neutral machine projection has no Agent; named Agents supply their declared fact.
    agentAcceptsUserMcp: params.agentAcceptsUserMcp ?? params.agentId == null });
  return { ...result, projectKey: context.projectKey, ...projectManagedMcpSelectionV1(result, { settings, context, selection: params.selection?.mcp }) };
}
