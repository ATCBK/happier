import React from 'react';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { createMcpActionChip } from '@/components/sessions/agentInput/definitions/createMcpActionChip';
import { NewSessionMcpSelectionContent } from '@/components/sessions/new/components/NewSessionMcpSelectionContent';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useNewSessionCapabilities } from '@/sync/domains/capabilities/session/useNewSessionCapabilities';
import { t } from '@/text';
import type { DaemonMcpServersPreviewResponse } from '@happier-dev/protocol';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { SessionMcpSelectionV1Schema } from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';

type PreviewSuccess = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;
export type UseNewSessionMcpSelectionResult = Readonly<{
    mcpChip: AgentInputExtraActionChip | null; mcpPreview: PreviewSuccess | null; mcpPreviewLoading: boolean;
}>;

/** Appearance adapter for the incumbent MCP chip; selection and preview belong to the generic hook. */
export function useNewSessionMcpSelection(params: Readonly<{
    selectedMachineId: string | null; selectedPath: string; selectedMachineName?: string | null;
    portableOnly?: boolean; agentType: string; targetServerId?: string | null;
    agentAcceptsUserMcp?: boolean;
    managedServersEnabledFromPreview?: boolean;
    capabilitySelection: SessionCapabilitySelectionV1;
    setCapabilitySelection: React.Dispatch<React.SetStateAction<SessionCapabilitySelectionV1>>;
    onOpenSettings: () => void;
}>): UseNewSessionMcpSelectionResult {
    const enabled = useFeatureEnabled('mcp.servers');
    const capabilities = useNewSessionCapabilities({
        machineId: params.selectedMachineId, directory: params.selectedPath, agentId: params.agentType,
        targetServerId: params.targetServerId, portableOnly: params.portableOnly, enabled,
        agentAcceptsUserMcp: params.agentAcceptsUserMcp,
        selection: params.capabilitySelection, setSelection: params.setCapabilitySelection,
    });
    const mcpPreview = capabilities.mcpPreview;
    const error = capabilities.error ?? capabilities.mcpPreviewError;
    const mcpPreviewLoading = capabilities.previewStatus === 'loading';
    const displayedSelection = React.useMemo(() => params.managedServersEnabledFromPreview && mcpPreview?.managed.length
        ? { ...params.capabilitySelection, mcp: { ...SessionMcpSelectionV1Schema.parse(params.capabilitySelection.mcp ?? {}),
            managedServersEnabled: mcpPreview.managed.some(item => item.selected) } } : params.capabilitySelection,
    [params.managedServersEnabledFromPreview, params.capabilitySelection, mcpPreview]);
    const contentProps = React.useMemo(() => ({
        machineId: params.selectedMachineId, targetServerId: params.targetServerId,
        machineName: params.selectedMachineName, directory: params.selectedPath.trim(),
        ...(params.portableOnly !== undefined ? { portableOnly: params.portableOnly } : {}),
        agentType: params.agentType,
        hasContext: params.portableOnly === true || Boolean(params.selectedMachineId && params.selectedPath.trim().length > 0),
        preview: mcpPreview, selection: displayedSelection, loading: mcpPreviewLoading,
        error: capabilities.unsupported ? null : error, previewUnsupported: capabilities.unsupported,
        onSelectionChange: params.setCapabilitySelection, onRefresh: capabilities.refresh,
        onOpenSettings: params.onOpenSettings,
    }), [params, displayedSelection, mcpPreview, mcpPreviewLoading, error, capabilities.unsupported, capabilities.refresh]);
    const selectedCount = enabled ? mcpPreview?.detected.filter(entry => entry.selected).length ?? 0 : 0;
    const label = t('newSession.mcpChipLabel');
    const stabilityKey = React.useMemo(() => JSON.stringify({
        machineId: params.selectedMachineId, directory: params.selectedPath.trim(), agentType: params.agentType,
        targetServerId: params.targetServerId ?? null, selection: params.capabilitySelection,
        preview: mcpPreview, loading: mcpPreviewLoading, error, previewUnsupported: capabilities.unsupported,
    }), [params.selectedMachineId, params.selectedPath, params.agentType, params.targetServerId,
        params.capabilitySelection, mcpPreview, mcpPreviewLoading, error, capabilities.unsupported]);
    const mcpChip = React.useMemo<AgentInputExtraActionChip | null>(() => enabled ? createMcpActionChip({
        label, selectedCount, stabilityKey, onIntent: capabilities.demandPreview,
        popoverContent: ({ maxHeight }) => <NewSessionMcpSelectionContent {...contentProps} maxHeight={Math.min(760, maxHeight)} />,
        maxHeightCap: 760, maxWidthCap: 620,
    }) : null, [enabled, label, selectedCount, stabilityKey, capabilities.demandPreview, contentProps]);
    return { mcpChip, mcpPreview, mcpPreviewLoading };
}
