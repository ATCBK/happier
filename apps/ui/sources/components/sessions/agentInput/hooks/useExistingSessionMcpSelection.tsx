import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { readSessionCapabilityOverrideV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { DaemonMcpServersPreviewResponse } from '@happier-dev/protocol/mcp/servers/previewV1';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { useNewSessionMcpSelection } from '@/components/sessions/new/hooks/useNewSessionMcpSelection';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSessionCapabilities } from '@/sync/domains/capabilities/session/useSessionCapabilities';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

export function shouldShowExistingSessionMcpChip(params: Readonly<{
    isReadOnly: boolean;
    sessionActive: boolean;
    agentAvailable: boolean;
}>): boolean {
    return !params.isReadOnly && params.agentAvailable;
}

export function useExistingSessionMcpSelection(params: Readonly<{
    sessionId: string;
    sessionMetadata: unknown;
    machineId: string | null;
    directory: string;
    agentId: string | null;
    serverId?: string | null;
    isReadOnly: boolean;
    sessionActive: boolean;
}>): AgentInputExtraActionChip | null {
    const router = useRouter();
    const capabilities = useSessionCapabilities(params.sessionId, params.sessionMetadata, { serverId: params.serverId });
    const previewRef = React.useRef<Extract<DaemonMcpServersPreviewResponse, { ok: true }> | null>(null);
    const selectionRef = React.useRef(capabilities.selection);
    selectionRef.current = capabilities.selection;
    const setCapabilitySelection = React.useCallback<React.Dispatch<React.SetStateAction<SessionCapabilitySelectionV1>>>((next) => {
        if (params.isReadOnly) return;
        const current = selectionRef.current;
        const value = typeof next === 'function' ? next(current) : next;
        const entries = previewRef.current?.managed ?? [];
        const enabled = entries.length ? entries.some(item => item.selected) : current.mcp?.managedServersEnabled !== false;
        const bulk = value.mcp?.managedServersEnabled !== undefined && value.mcp.managedServersEnabled !== enabled;
        const ids = new Set(bulk ? entries.filter(item => item.selectable).map(item => item.serverId)
            : [...(current.mcp?.forceIncludeServerIds ?? []), ...(current.mcp?.forceExcludeServerIds ?? []),
                ...(value.mcp?.forceIncludeServerIds ?? []), ...(value.mcp?.forceExcludeServerIds ?? [])]);
        const writes = [...ids].flatMap(id => {
            const state = bulk ? value.mcp?.managedServersEnabled ? 'on' : 'off' : readSessionCapabilityOverrideV1(value, 'mcp_server', id);
            if (readSessionCapabilityOverrideV1(current, 'mcp_server', id) === state) return [];
            return [capabilities.setItem('mcp_server', id, state)];
        });
        void Promise.all(writes).then(results => {
            if (results.some(result => !result.ok)) Modal.alert(t('common.error'), t('errors.operationFailed'));
        });
    }, [capabilities.setItem, params.isReadOnly]);
    const selection = useNewSessionMcpSelection({
        selectedMachineId: params.agentId ? params.machineId : null,
        selectedPath: params.directory,
        agentType: params.agentId ?? '',
        targetServerId: params.serverId ?? null,
        capabilitySelection: capabilities.selection,
        setCapabilitySelection,
        onOpenSettings: () => router.push('/settings/mcp'),
        managedServersEnabledFromPreview: true,
    });
    previewRef.current = selection.mcpPreview;

    return shouldShowExistingSessionMcpChip({
        isReadOnly: params.isReadOnly,
        sessionActive: params.sessionActive,
        agentAvailable: Boolean(params.agentId),
    }) ? selection.mcpChip : null;
}
