import * as React from 'react';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';

import type { DaemonMcpServersDetectWarningV1, DetectedMcpServerV1 } from '@happier-dev/protocol';
import { MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/mcp/servers/serverActionsV1';

import { MachineAdministrationTargetSelector } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import { SettingsPageHeader } from '@/components/settings/shell/SettingsPageHeader';
import { ItemList } from '@/components/ui/lists/ItemList';
import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { useHappyAction } from '@/hooks/ui/useHappyAction';
import { Modal } from '@/modal';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { ActionApprovalPendingNotice } from '@/components/approvals/ActionApprovalPendingNotice';
import { MACHINE_ADMINISTRATION_SELECTION_KEYS_V1 } from '@/sync/domains/machines/administration/selectionPreferences';
import { useMachineAdministrationExecutionTargetBinding } from '@/sync/domains/machines/administration/useExecutionTargetBinding';
import { useMachineAdministrationTargetSelection } from '@/sync/domains/machines/administration/useTargetSelection';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { loadFoundWarmCacheEntry, saveFoundWarmCacheEntry, subscribeFoundWarmCacheEntry } from '@/sync/domains/state/warmCachePersistence';

import { McpDetectedServersTab } from './McpDetectedServersTab';
import { mcpServerRoute } from './collection/mcpServerCollectionModel';
import { useMcpServersSettings, useMcpServerCatalogForServer } from './useMcpServersSettings';
import { McpFoundAdoptionPanel } from './found/McpFoundAdoptionPanel';
import { useMcpFoundAdoption } from './found/useMcpFoundAdoption';

/**
 * `/settings/mcp/found`: the MCP servers other agents configure on the managed machine, with an
 * Import for each. The machine chip in the header scopes the whole page; it stays through loading,
 * offline and error states because it is the control that recovers them.
 */
export const McpDetectedServersScreen = React.memo(function McpDetectedServersScreen() {
    const router = useRouter();
    const { approval: importApproval, scope } = useMcpServersSettings();
    const targetSelection = useMachineAdministrationTargetSelection(MACHINE_ADMINISTRATION_SELECTION_KEYS_V1.mcpServers);
    const selectedTarget = targetSelection.selectedTarget;
    const { selectionKey, resolveExactExecutionTarget, isExecutionTargetCurrent } = useMachineAdministrationExecutionTargetBinding(targetSelection);
    const executionTarget = resolveExactExecutionTarget(selectedTarget, { intent: 'retry' });
    const probeExecution = useMountedActionExecution(executionTarget?.serverId);
    const snapshot = useMcpServerCatalogForServer(executionTarget?.serverId);
    const adoptionRevision = snapshot.status === 'ready' && snapshot.authority === 'active' && !snapshot.stale
        && typeof snapshot.revision === 'number' ? snapshot.revision : null;
    const adoptionTarget = resolveExactExecutionTarget(selectedTarget);
    const adoptionExecution = React.useMemo(() => ({ execute: probeExecution.execute,
        ready: Boolean(adoptionTarget && probeExecution.ready),
        isCurrent: () => Boolean(adoptionTarget && probeExecution.isCurrent()
            && isExecutionTargetCurrent(selectionKey, adoptionTarget)),
    }), [adoptionTarget, probeExecution.execute, probeExecution.ready, probeExecution.isCurrent, isExecutionTargetCurrent, selectionKey]);
    const adoption = useMcpFoundAdoption({ machineId: adoptionTarget?.machine.id ?? null,
        scopeKey: JSON.stringify([selectionKey, probeExecution.binding?.scope]), catalog: snapshot.value,
        catalogRevision: adoptionRevision, execution: adoptionExecution });
    const savedSecretCatalog = useSavedSecretCatalog({ scope: probeExecution.binding?.scope ?? null });
    const secrets = React.useMemo(() => [...savedSecretCatalog.materializedSecrets], [savedSecretCatalog.materializedSecrets]);
    const [directory, setDirectory] = React.useState('');
    const directoryRef = React.useRef(directory);
    directoryRef.current = directory;
    const [detected, setDetected] = React.useState<DetectedMcpServerV1[] | null>(null);
    const [warnings, setWarnings] = React.useState<DaemonMcpServersDetectWarningV1[] | null>(null);
    const previousSelectionKeyRef = React.useRef(selectionKey);
    const cacheScope = probeExecution.binding?.scope;
    const selectedMachineId = selectedTarget?.machineId ?? '';
    const readFoundCache = React.useCallback(() => loadFoundWarmCacheEntry(cacheScope?.serverId, cacheScope?.accountId, 'mcp_server', selectedMachineId),
        [cacheScope?.serverId, cacheScope?.accountId, selectedMachineId]);
    const subscribeFoundCache = React.useCallback((listener: () => void) => subscribeFoundWarmCacheEntry(cacheScope?.serverId, cacheScope?.accountId,
        'mcp_server', selectedMachineId, listener), [cacheScope?.serverId, cacheScope?.accountId, selectedMachineId]);
    const lastKnown = React.useSyncExternalStore(subscribeFoundCache, readFoundCache, readFoundCache);

    // A different machine is a different place to look: its folder and its findings start empty.
    React.useLayoutEffect(() => {
        const previousSelectionKey = previousSelectionKeyRef.current;
        previousSelectionKeyRef.current = selectionKey;
        if (!previousSelectionKey || previousSelectionKey === selectionKey) return;
        setDirectory('');
    }, [selectionKey]);
    React.useEffect(() => {
        const result = lastKnown?.kind === 'mcp_server' && lastKnown.result.ok ? lastKnown.result : null;
        setDetected(result?.servers ?? null);
        setWarnings(result?.warnings ?? null);
    }, [selectionKey, lastKnown]);

    const detectAction = React.useCallback(async (intent?: 'retry') => {
        const requestedSelection = selectionKey;
        const executionTarget = resolveExactExecutionTarget(selectedTarget, intent ? { intent } : undefined);
        if (!executionTarget || !probeExecution.ready) return;
        // No `providers` filter: the daemon on this exact machine owns the
        // current MCP discovery-source registry, including the sources an
        // installed Agent contributes. Sending this app binary's bundled Agent
        // list instead would drop every installed Agent's source before
        // detection even runs.
        const receipt = await probeExecution.execute('mcp.found.list', {
            machineId: executionTarget.machine.id,
            directory: directoryRef.current.trim() || undefined,
        });
        if (!isExecutionTargetCurrent(requestedSelection, executionTarget, intent ? { intent } : undefined)) return;
        if (!receipt.ok) {
            Modal.alert(t('common.error'), receipt.errorCode ?? receipt.error);
            return;
        }
        const response = MCP_SERVER_ACTION_OUTPUT_SCHEMAS_V1['mcp.found.list'].parse(receipt.result);
        if (!response.ok) {
            Modal.alert(t('common.error'), response.error);
            return;
        }
        setDetected(response.servers);
        setWarnings(response.warnings ?? null);
        if (cacheScope) saveFoundWarmCacheEntry(cacheScope.serverId, cacheScope.accountId, { kind: 'mcp_server', machineId: executionTarget.machine.id,
            observedAt: Date.now(), result: response });
    }, [cacheScope, isExecutionTargetCurrent, resolveExactExecutionTarget, selectedTarget, selectionKey, probeExecution.execute, probeExecution.ready]);
    const [loading, runDetect] = useHappyAction(detectAction, { mode: 'rerun_latest' });

    React.useEffect(() => {
        void runDetect();
    }, [runDetect, selectionKey]);

    const adoptedServerId = adoption.state.status === 'adopted' ? adoption.state.serverId : null;
    React.useEffect(() => {
        if (!adoptedServerId) return;
        const result = runGuardedNavigation(() => router.replace(mcpServerRoute(adoptedServerId) as never));
        if (result !== true) fireAndForget(result, { tag: 'McpDetectedServersScreen.import' });
    }, [adoptedServerId, router]);

    return (
        <ItemList keyboardShouldPersistTaps="handled">
            <SettingsPageHeader
                description={t('mcpSettings.onMachinePurpose')}
                actions={(
                    <MachineAdministrationTargetSelector
                        selection={targetSelection}
                        presentation="chip"
                        testIDPrefix="settings.mcpServers.administration.target"
                    />
                )}
            />
            {importApproval.approvalId && scope ? (
                <ActionApprovalPendingNotice testID="mcp.detected.import.approval"
                    message={t('secrets.catalog.approvalPending')}
                    onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(importApproval.approvalId!)}?serverId=${encodeURIComponent(scope.serverId)}`)} />
            ) : null}
            {probeExecution.approval.approvalId && executionTarget ? (
                <ActionApprovalPendingNotice testID="mcp.detected.approval"
                    message={t('secrets.catalog.approvalPending')}
                    onOpenApproval={() => router.pushRetainingCurrent(`/inbox/approvals/${encodeURIComponent(probeExecution.approval.approvalId!)}?serverId=${encodeURIComponent(executionTarget.serverId)}`)} />
            ) : null}
            <McpDetectedServersTab
                selectedMachineId={executionTarget?.machine.id ?? null}
                selectedServerId={executionTarget?.serverId ?? null}
                canExecute={executionTarget !== null && probeExecution.ready}
                canImport={executionTarget !== null && probeExecution.ready && adoptionRevision !== null}
                directory={directory}
                onChangeDirectory={setDirectory}
                loading={loading}
                detected={detected}
                warnings={warnings}
                onRefresh={() => { void runDetect('retry'); }}
                onImport={(server) => { void adoption.begin(server); }}
                adopting={adoption.item}
                adoptionPanel={(
                    <McpFoundAdoptionPanel
                        testID="mcp.detected.adopt"
                        adoption={adoption}
                        secrets={secrets}
                        scope={probeExecution.binding?.scope ?? null}
                    />
                )}
            />
        </ItemList>
    );
});
