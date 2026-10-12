import * as React from 'react';
import { SessionCapabilitySelectionAuthoringV1Schema, areSessionCapabilitySelectionsEquivalentV1,
    type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { resolveSessionCapabilitiesV1 } from '@happier-dev/protocol/reach/resolveSessionCapabilitiesV1';
import { projectManagedMcpSelectionV1, projectManagedMcpPreviewEntriesV1,
    type DaemonMcpServersPreviewResponse } from '@happier-dev/protocol/mcp/servers/previewV1';
import { EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { agentReceivesUserMcpServersV1 } from '@happier-dev/protocol/plugins/contributions/v2';
import { getAgentCore } from '@/agents/catalog/catalog';
import { useMcpServerCatalogForServer } from '@/components/settings/mcpServers/useMcpServersSettings';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { refreshMcpServerCatalog } from '@/sync/engine/settings/mcpServerCatalogEngine';
import { machineMcpServersPreview } from '@/sync/ops/machineMcpServers';
import { isMachineRequestReachabilityFailure } from '@/sync/domains/machines/reachability/machineReachability';
import { isRpcMethodNotAvailableError, isRpcMethodNotFoundError } from '@/sync/runtime/rpcErrors';
import { setSessionCapabilitySelectionItem } from './sessionCapabilitySelectionState';

type Preview = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;
export type CapabilityPreviewStatus = 'idle' | 'loading' | 'ready' | 'unreachable' | 'error';

/** Draft selection and preview state. U5 replaces the retained MCP RPC with the capability Action. */
export function useNewSessionCapabilities(draft: Readonly<{
    machineId: string | null; directory: string; agentId: string; targetServerId?: string | null;
    portableOnly?: boolean; enabled: boolean;
    agentAcceptsUserMcp?: boolean;
    selection: SessionCapabilitySelectionV1;
    setSelection: React.Dispatch<React.SetStateAction<SessionCapabilitySelectionV1>>;
}>) {
    const [demanded, setDemanded] = React.useState(false);
    const { binding } = useServerCredentialAccountScopeBinding(draft.targetServerId);
    const contextKey = JSON.stringify([binding?.scope.serverId ?? null, binding?.scope.accountId ?? null,
        draft.machineId, draft.directory.trim(), draft.agentId, draft.targetServerId ?? null, draft.portableOnly === true]);
    const [previewState, setPreviewState] = React.useState<Readonly<{ contextKey: string; value: Preview }> | null>(null);
    const preview = previewState?.contextKey === contextKey ? previewState.value : null;
    const [previewStatus, setPreviewStatus] = React.useState<CapabilityPreviewStatus>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const [unsupported, setUnsupported] = React.useState(false);
    const requestRef = React.useRef(0);
    const catalog = useMcpServerCatalogForServer(draft.targetServerId, demanded && draft.enabled && draft.portableOnly === true);
    const selection = React.useMemo(() => SessionCapabilitySelectionAuthoringV1Schema.parse(draft.selection), [draft.selection]);
    const setItem = React.useCallback((kind: 'skill' | 'mcp_server' | 'native_skill', id: string, state: 'on' | 'off' | 'inherit') => {
        draft.setSelection(current => {
            const next = setSessionCapabilitySelectionItem(current, kind, id, state);
            return areSessionCapabilitySelectionsEquivalentV1(current, next) ? current : next;
        });
    }, [draft.setSelection]);
    const demandPreview = React.useCallback(() => setDemanded(true), []);

    const refresh = React.useCallback(async () => {
        const request = ++requestRef.current;
        if (!draft.enabled || (!draft.portableOnly && (!draft.machineId || !draft.directory.trim()))) {
            setPreviewStatus('idle'); setError(null); setUnsupported(false);
            return;
        }
        setPreviewStatus('loading'); setError(null); setUnsupported(false);
        if (draft.portableOnly) {
            if (catalog.status !== 'ready' || catalog.authority !== 'active' || catalog.stale || !catalog.value) {
                setPreviewStatus(catalog.status === 'unavailable' || catalog.status === 'partial' ? 'error' : 'loading');
                setError(catalog.status === 'unavailable' || catalog.status === 'partial' ? catalog.reason ?? 'catalog_unavailable' : null);
                return;
            }
            const settings = { ...catalog.value, strictMode: false };
            const context = { machineId: EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1, machinePlatform: null,
                directory: null, projectKey: null, agentId: draft.agentId };
            const effective = resolveSessionCapabilitiesV1({ context, mcp: settings, skills: null, selection,
                agentAcceptsUserMcp: draft.agentAcceptsUserMcp ?? agentReceivesUserMcpServersV1(getAgentCore(draft.agentId)?.tools.delivery) });
            setPreviewState({ contextKey, value: { ok: true, builtIn: [], detected: [], managed: projectManagedMcpPreviewEntriesV1(
                projectManagedMcpSelectionV1(effective, { settings, context, selection: selection.mcp })) } });
            setPreviewStatus('ready');
            return;
        }
        try {
            const response = await machineMcpServersPreview(draft.machineId!, {
                agentId: draft.agentId, directory: draft.directory.trim(), capabilitySelection: selection,
            }, { serverId: draft.targetServerId ?? undefined });
            if (request !== requestRef.current) return;
            if (response.ok) { setPreviewState({ contextKey, value: response }); setPreviewStatus('ready'); }
            else { setError(response.error); setPreviewStatus('error');
                setUnsupported(response.error === 'RPC method not available' || response.error === 'Method not found'); }
        } catch (failure) {
            if (request !== requestRef.current) return;
            setUnsupported(isRpcMethodNotAvailableError(failure) || isRpcMethodNotFoundError(failure));
            setError(failure instanceof Error ? failure.message : String(failure));
            setPreviewStatus(isMachineRequestReachabilityFailure(failure) ? 'unreachable' : 'error');
        }
    }, [draft.enabled, draft.portableOnly, draft.machineId, draft.directory, draft.agentId, draft.agentAcceptsUserMcp, draft.targetServerId, selection, catalog, contextKey]);
    React.useEffect(() => {
        if (demanded) void refresh();
        return () => { requestRef.current += 1; };
    }, [demanded, refresh]);
    const retry = React.useCallback(async () => {
        if (!demanded) { setDemanded(true); return; }
        if (draft.portableOnly && binding?.isCurrent()) await refreshMcpServerCatalog(binding.scope);
        await refresh();
    }, [demanded, draft.portableOnly, binding, refresh]);
    return { selection, setItem, preview, previewStatus, lastKnownPreview: preview,
        error, unsupported, demandPreview, refresh: retry };
}
