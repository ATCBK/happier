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

export function resolveSessionMcpPreview(params: Readonly<{
  settings: McpServersSettingsV1;
  machineId: string;
  directory: string;
  agentId: string;
  capabilitySelection?: SessionCapabilitySelectionV1 | null;
  detectedServers: ReadonlyArray<DetectedMcpServerV1>;
  detectedWarnings?: ReadonlyArray<DaemonMcpServersDetectWarningV1>;
}>): Extract<DaemonMcpServersPreviewResponse, { ok: true }> {
  const managedSelection = resolveSessionCapabilitiesForDirectory({
    settings: params.settings,
    machineId: params.machineId,
    directory: params.directory,
    selection: params.capabilitySelection ?? {},
    agentId: params.agentId,
    agentAcceptsUserMcp: agentReceivesUserMcpServersV1(resolveAgentToolsDelivery(params.agentId)),
  });

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
