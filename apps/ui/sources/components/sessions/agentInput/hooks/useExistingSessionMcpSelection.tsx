import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import {
    SessionMcpSelectionV1Schema,
    type SessionMcpSelectionV1,
} from '@happier-dev/protocol/mcp/servers/sessionSelectionV1';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { useNewSessionMcpSelection } from '@/components/sessions/new/hooks/useNewSessionMcpSelection';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSessionCapabilities } from '@/sync/domains/capabilities/session/useSessionCapabilities';
import type { SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';

const DEFAULT_MCP_SELECTION = SessionMcpSelectionV1Schema.parse({});

function selectionKey(selection: SessionMcpSelectionV1): string {
    return JSON.stringify(selection);
}

export function shouldShowExistingSessionMcpChip(params: Readonly<{
    isReadOnly: boolean;
    sessionActive: boolean;
    agentAvailable: boolean;
}>): boolean {
    return !params.isReadOnly && params.agentAvailable;
}

export function resolveExistingSessionMcpSelectionRollback(params: Readonly<{
    failedSelectionKey: string;
    pendingSelectionKey: string | null;
    persistedSelection: SessionMcpSelectionV1;
}>): SessionMcpSelectionV1 | null {
    return params.pendingSelectionKey === params.failedSelectionKey ? params.persistedSelection : null;
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
    applySelection: (selection: SessionMcpSelectionV1) => Promise<void>;
}>): AgentInputExtraActionChip | null {
    const router = useRouter();
    const capabilities = useSessionCapabilities(params.sessionId, params.sessionMetadata);
    const persistedSelection = capabilities.selection.mcp;
    const persistedSelectionRef = React.useRef(persistedSelection);
    persistedSelectionRef.current = persistedSelection;
    const [optimisticSelection, setOptimisticSelection] = React.useState(persistedSelection);
    const optimisticSelectionRef = React.useRef(optimisticSelection);
    optimisticSelectionRef.current = optimisticSelection;
    const pendingSelectionKeyRef = React.useRef<string | null>(null);
    const writeQueueRef = React.useRef<Promise<void>>(Promise.resolve());

    React.useEffect(() => {
        const incomingKey = selectionKey(persistedSelection);
        if (pendingSelectionKeyRef.current && pendingSelectionKeyRef.current !== incomingKey) return;
        pendingSelectionKeyRef.current = null;
        setOptimisticSelection((current) => selectionKey(current) === incomingKey ? current : persistedSelection);
    }, [persistedSelection]);

    const setSelection = React.useCallback<React.Dispatch<React.SetStateAction<SessionMcpSelectionV1>>>((nextValue) => {
        if (params.isReadOnly) return;
        const previous = optimisticSelectionRef.current;
        const next = SessionMcpSelectionV1Schema.parse(
            typeof nextValue === 'function' ? nextValue(previous) : nextValue,
        );
        const nextKey = selectionKey(next);
        if (nextKey === selectionKey(previous)) return;
        optimisticSelectionRef.current = next;
        pendingSelectionKeyRef.current = nextKey;
        setOptimisticSelection(next);

        writeQueueRef.current = writeQueueRef.current
            .catch(() => undefined)
            .then(async () => {
                await params.applySelection(next);
            })
            .catch(() => {
                const rollback = resolveExistingSessionMcpSelectionRollback({
                    failedSelectionKey: nextKey,
                    pendingSelectionKey: pendingSelectionKeyRef.current,
                    persistedSelection: persistedSelectionRef.current,
                });
                if (!rollback) return;
                pendingSelectionKeyRef.current = null;
                optimisticSelectionRef.current = rollback;
                setOptimisticSelection(rollback);
                Modal.alert(t('common.error'), t('errors.operationFailed'));
            });
    }, [params.applySelection, params.isReadOnly]);

    const capabilitySelection = React.useMemo(() => ({ ...capabilities.selection, mcp: optimisticSelection }), [capabilities.selection, optimisticSelection]);
    const setCapabilitySelection = React.useCallback<React.Dispatch<React.SetStateAction<SessionCapabilitySelectionV1>>>((next) => {
        const value = typeof next === 'function' ? next({ ...capabilities.selection, mcp: optimisticSelectionRef.current }) : next;
        setSelection(value.mcp ?? DEFAULT_MCP_SELECTION);
    }, [capabilities.selection, setSelection]);
    const selection = useNewSessionMcpSelection({
        selectedMachineId: params.agentId ? params.machineId : null,
        selectedPath: params.directory,
        agentType: params.agentId ?? '',
        targetServerId: params.serverId ?? null,
        capabilitySelection,
        setCapabilitySelection,
        onOpenSettings: () => router.push('/settings/mcp'),
    });

    return shouldShowExistingSessionMcpChip({
        isReadOnly: params.isReadOnly,
        sessionActive: params.sessionActive,
        agentAvailable: Boolean(params.agentId),
    }) ? selection.mcpChip : null;
}
