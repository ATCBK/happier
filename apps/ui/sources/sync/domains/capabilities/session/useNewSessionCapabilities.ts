import * as React from 'react';
import { SessionCapabilitySelectionAuthoringV1Schema, areSessionCapabilitySelectionsEquivalentV1,
    type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import type { DaemonMcpServersPreviewResponse } from '@happier-dev/protocol/mcp/servers/previewV1';
import { EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1 } from '@happier-dev/protocol/ephemeralRunner/runnerMcpMaterial';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { SpawnCapabilitiesPreviewOutputV1Schema, type SpawnCapabilitiesPreviewOutputV1 } from '@happier-dev/protocol/actions/specs/sessionCapabilities';
import { isMachineRequestReachabilityFailure } from '@/sync/domains/machines/reachability/machineReachability';
import { isRpcMethodNotFoundError } from '@happier-dev/protocol/rpcErrors';
import { setSessionCapabilitySelectionItem } from './sessionCapabilitySelectionState';

type Preview = Extract<SpawnCapabilitiesPreviewOutputV1, { ok: true }>;
type McpPreview = Extract<DaemonMcpServersPreviewResponse, { ok: true }>;
export type CapabilityPreviewStatus = 'idle' | 'loading' | 'ready' | 'unreachable' | 'error';

/** Draft selection and demanded preview through the canonical capability Action. */
export function useNewSessionCapabilities(draft: Readonly<{
    machineId: string | null; directory: string; agentId: string; targetServerId?: string | null;
    portableOnly?: boolean; enabled?: boolean;
    agentAcceptsUserMcp?: boolean;
    projectKey?: string; profileId?: string;
    selection: SessionCapabilitySelectionV1;
    setSelection: React.Dispatch<React.SetStateAction<SessionCapabilitySelectionV1>>;
}>) {
    const [demanded, setDemanded] = React.useState(false);
    const enabled = draft.enabled !== false;
    const active = useActiveServerSnapshot(!draft.targetServerId);
    const targetServerId = draft.targetServerId ?? active.serverId;
    const { binding } = useServerCredentialAccountScopeBinding(targetServerId);
    const execution = useMountedActionExecution(binding?.scope);
    const contextKey = JSON.stringify([binding?.scope.serverId ?? null, binding?.scope.accountId ?? null,
        draft.machineId, draft.directory.trim(), draft.agentId, draft.targetServerId ?? null, draft.portableOnly === true, draft.projectKey, draft.profileId]);
    const [previewState, setPreviewState] = React.useState<Readonly<{ contextKey: string; value: Preview | null; mcp: McpPreview | null }> | null>(null);
    const preview = previewState?.contextKey === contextKey ? previewState.value : null;
    const mcpPreview = previewState?.contextKey === contextKey ? previewState.mcp : null;
    const [previewStatus, setPreviewStatus] = React.useState<CapabilityPreviewStatus>('idle');
    const [error, setError] = React.useState<string | null>(null);
    const [unsupported, setUnsupported] = React.useState(false);
    const requestRef = React.useRef(0);
    const pendingRequest = React.useRef<number | null>(null);
    const requestedFacts = React.useRef<Readonly<{ contextKey: string; factsKey: string }> | null>(null);
    const selection = React.useMemo(() => SessionCapabilitySelectionAuthoringV1Schema.parse(draft.selection), [draft.selection]);
    const setItem = React.useCallback((kind: 'skill' | 'mcp_server' | 'native_skill', id: string, state: 'on' | 'off' | 'inherit') => {
        draft.setSelection(current => {
            const next = setSessionCapabilitySelectionItem(current, kind, id, state);
            return areSessionCapabilitySelectionsEquivalentV1(current, next) ? current : next;
        });
    }, [draft.setSelection]);
    const refresh = React.useCallback(async (factsKey?: string) => {
        if (typeof factsKey === 'string' && requestedFacts.current?.contextKey === contextKey && requestedFacts.current.factsKey === factsKey) return;
        requestedFacts.current = typeof factsKey === 'string' ? { contextKey, factsKey } : null;
        const request = ++requestRef.current;
        if (!enabled || (!draft.portableOnly && !draft.machineId)) {
            setPreviewStatus('idle'); setError(null); setUnsupported(false);
            return;
        }
        pendingRequest.current = request;
        setPreviewStatus('loading'); setError(null); setUnsupported(false);
        try {
            const receipt = await execution.execute('sessions.spawn.capabilities.preview', {
                machineId: draft.portableOnly ? EPHEMERAL_RUNNER_UNMATERIALIZED_MACHINE_ID_V1 : draft.machineId!, agentId: draft.agentId,
                ...(!draft.portableOnly && draft.directory.trim() ? { directory: draft.directory.trim() } : {}),
                ...(!draft.portableOnly && draft.projectKey ? { projectKey: draft.projectKey } : {}), ...(draft.profileId ? { profileId: draft.profileId } : {}),
                capabilitySelection: selection,
            });
            if (request !== requestRef.current) return;
            const parsed = receipt.ok ? SpawnCapabilitiesPreviewOutputV1Schema.safeParse(receipt.result) : null;
            if (parsed?.success && parsed.data.ok) {
                const response = parsed.data;
                const completeRenderingProjection = response.mcp.items.every(item => item.preview !== undefined);
                setPreviewState(current => ({ contextKey, value: response,
                    mcp: completeRenderingProjection ? { ok: true, builtIn: [], detected: response.mcp.detected,
                        managed: response.mcp.items.flatMap(item => item.preview ? [item.preview] : []) }
                        : current?.contextKey === contextKey ? current.mcp : null }));
                setPreviewStatus('ready');
            } else {
                const message = !receipt.ok ? receipt.errorCode ?? receipt.error : parsed?.success && !parsed.data.ok ? parsed.data.reason : 'invalid_action_output';
                setError(message); setPreviewStatus(message === 'machine_unreachable' || isMachineRequestReachabilityFailure({ code: message }) ? 'unreachable' : 'error');
                setUnsupported(isRpcMethodNotFoundError({ rpcErrorCode: message }));
            }
        } catch (failure) {
            if (request !== requestRef.current) return;
            setUnsupported(isRpcMethodNotFoundError(failure));
            setError(failure instanceof Error ? failure.message : String(failure));
            setPreviewStatus(isMachineRequestReachabilityFailure(failure) ? 'unreachable' : 'error');
        } finally {
            if (pendingRequest.current === request) pendingRequest.current = null;
        }
    }, [enabled, draft.portableOnly, draft.machineId, draft.directory, draft.agentId, draft.projectKey, draft.profileId, execution.execute, selection, contextKey]);
    React.useEffect(() => {
        if (demanded && execution.ready) void refresh();
        return () => { requestRef.current += 1; };
    }, [demanded, refresh, execution.ready]);
    const demandPreview = React.useCallback(() => {
        // Intent events share pending work; changed inputs and Retry remain fresh.
        if (pendingRequest.current !== null) return;
        if (demanded && execution.ready) void refresh();
        else setDemanded(true);
    }, [demanded, execution.ready, refresh]);
    const retry = React.useCallback(async (factsKey?: string) => {
        if (!demanded) { setDemanded(true); return; }
        await refresh(factsKey);
    }, [demanded, refresh]);
    const mcpPreviewError = preview?.mcp.items.some(item => item.preview === undefined) ? 'invalid_action_output' : null;
    return { selection, setItem, preview, mcpPreview, mcpPreviewError, previewStatus, lastKnownPreview: preview,
        error, unsupported, demandPreview, refresh: retry };
}
