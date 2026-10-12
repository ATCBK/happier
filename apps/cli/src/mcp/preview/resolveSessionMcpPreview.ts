import type {
  BuiltInMcpPreviewEntryV1,
  DaemonMcpServersDetectWarningV1,
  DaemonMcpServersPreviewResponse,
  DetectedMcpServerV1,
  McpServersSettingsV1,
  SessionCapabilitySelectionV1,
} from '@happier-dev/protocol';

import { resolveSessionCapabilitiesForDirectory } from '@/mcp/servers/resolveSessionCapabilitiesForDirectory';
import { agentReceivesUserMcpServersV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { resolveAgentToolsDelivery } from '@/agent/tools/happierTools/runtime/resolveAgentToolsDelivery';
import type { SessionProjectPromptStackInput } from '@/workspaces/resolveSessionProjectKey';

import { buildManagedMcpPreviewEntries } from './buildManagedMcpPreviewEntries';
import { resolveDetectedMcpPreviewEntries } from './resolveDetectedMcpPreviewEntries';

function createBuiltInMcpPreviewEntry(): BuiltInMcpPreviewEntryV1 {
  return {
    key: 'built-in:happier',
    name: 'happier',
    title: 'Happier',
    transport: 'stdio',
    authMode: 'none',
    selected: true,
    selectable: false,
    availability: 'active',
    sourceKind: 'builtIn',
    scopeKind: 'builtIn',
  };
}

function formatWarning(warning: DaemonMcpServersDetectWarningV1): string {
  const provider = warning.provider ?? 'unattributed';
  return `${provider}:${warning.code}${warning.path ? `:${warning.path}` : ''}`;
}

export async function resolveSessionMcpPreview(params: Readonly<{
  settings: McpServersSettingsV1;
  machineId: string;
  directory: string | null;
  agentId: string;
  projectKey?: string | null;
  sessionProject?: Omit<SessionProjectPromptStackInput, 'machineId' | 'directory'>;
  capabilitySelection?: SessionCapabilitySelectionV1 | null;
  detectedServers: ReadonlyArray<DetectedMcpServerV1>;
  detectedWarnings?: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>): Promise<Extract<DaemonMcpServersPreviewResponse, { ok: true }>> {
  const context = {
    settings: params.settings,
    machineId: params.machineId,
    directory: params.directory,
    selection: params.capabilitySelection ?? {},
    agentId: params.agentId,
    ...(params.projectKey !== undefined ? { projectKey: params.projectKey } : {}),
    agentAcceptsUserMcp: agentReceivesUserMcpServersV1(resolveAgentToolsDelivery(params.agentId)),
  };
  const managedSelection = await (params.sessionProject
    ? resolveSessionCapabilitiesForDirectory({ ...context, sessionProject: params.sessionProject })
    : resolveSessionCapabilitiesForDirectory(context));

  const builtIn = [createBuiltInMcpPreviewEntry()];
  const managed = buildManagedMcpPreviewEntries(managedSelection);
  const detected = resolveDetectedMcpPreviewEntries({
    agentId: params.agentId,
    servers: params.detectedServers,
  });
  const warnings = (params.detectedWarnings ?? []).map(formatWarning).filter((value) => value.length > 0);

  return {
    ok: true,
    builtIn,
    managed,
    detected,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
