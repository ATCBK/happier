import * as React from 'react';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { buildBackendTargetKeyV2, readBackendTargetRefV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ScmDiffSummaryModelSelector } from '@happier-dev/protocol/scm/diffSummary';
import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useSetting } from '@/sync/domains/state/storage';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { decodeScmDiffSummaryModelOverride } from '@/settings/scmDiffSummary/settings';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { t } from '@/text';
import { AgentIcon } from '@/agents/registry/AgentIcon';

export type ScmDiffSummaryModelSelection = Readonly<{ backendTarget: BackendTargetRefV2; modelSelector: ScmDiffSummaryModelSelector }>;

function targetFor(entry: ResolvedBackendCatalogEntry): BackendTargetRefV2 | null {
    try { return readBackendTargetRefV2(entry.backendTarget); }
    catch { return entry.compatibilityBackendTargets?.[0] ?? null; }
}

/** One offered-model projection for Settings, the picker, and restored generation controls. */
export function useScmDiffSummaryModelChoices(params: Readonly<{
    value: string;
    machineId?: string | null;
    serverId?: string | null;
    defaultBackendTarget?: BackendTargetRefV2 | null;
    /** A mounted result still observes its selected model when its picker is hidden. */
    observeSelection?: boolean;
}>) {
    const [open, setOpen] = React.useState(false);
    const [discoveryTargetKey, setDiscoveryTargetKey] = React.useState<string | null>(null);
    const enabledAgentIds = useEnabledAgentIds();
    const { snapshot: acpCatalog } = useAcpCatalogForServer(params.serverId);
    const catalogReady = acpCatalog?.catalog.status === 'ready' && !acpCatalog.stale;
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey') as Record<string, boolean> | undefined;
    const observing = open || params.observeSelection === true;
    const daemon = useDaemonMergedProjectionInputs({ machineId: params.machineId ?? null, serverId: params.serverId ?? null, enabled: observing && Boolean(params.machineId) });
    const entries = React.useMemo(() => getResolvedBackendCatalogEntries({ enabledAgentIds,
        acpCatalogSnapshot: acpCatalog?.catalog, backendEnabledByTargetKey,
        discoveredBackendIds: daemon.inputs?.discoveredBackendIds,
        mergedProviderProjectionById: daemon.inputs?.mergedProviderProjectionById,
        mergedBackendProjectionById: daemon.inputs?.mergedBackendProjectionById,
    }), [enabledAgentIds, acpCatalog, backendEnabledByTargetKey, daemon.inputs]);
    const selected = decodeScmDiffSummaryModelOverride(params.value);
    const selectedEntry = entries.find((entry) => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === selected?.backendTargetKey;
    });
    const discoveryEntry = entries.find(entry => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === discoveryTargetKey;
    });
    const probeEntry = discoveryEntry ?? selectedEntry;
    const probeTarget = probeEntry ? targetFor(probeEntry) : params.defaultBackendTarget;
    const probe = useNewSessionPreflightModelsState({ backendTarget: probeTarget,
        runtimeCarrierAgentId: probeEntry?.agentId, selectedMachineId: params.machineId ?? null,
        capabilityServerId: params.serverId ?? '',
        enabled: observing && Boolean(params.machineId) && (probeEntry?.kind !== 'configuredBackend' || catalogReady),
    });
    const selections = new Map<string, ScmDiffSummaryModelSelection>();
    const discoveryTargets = new Map<string, string>();
    const items: DropdownMenuItem[] = [];
    for (const entry of entries) {
        const target = targetFor(entry);
        if (!target) continue;
        const dynamic = probeTarget && buildBackendTargetKeyV2(target) === buildBackendTargetKeyV2(probeTarget) && probe.preflightModels ? probe.preflightModels.availableModels : null;
        const staticModels = getAgentStaticModels(entry.agentId, { catalogOnly: true });
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: target, models: dynamic ?? staticModels,
            agentFormats: entry.kind === 'builtInAgent' ? getAgentCore(entry.agentId)?.structuredOutput?.formats : null });
        const targetKey = buildBackendTargetKeyV2(target);
        const id = `backend-discovery:${targetKey}`;
        discoveryTargets.set(id, targetKey);
        const icon = React.createElement(AgentIcon, { agentId: entry.agentId, size: 22 });
        items.push({ id, title: t('walkthroughSettings.loadModels'), category: entry.title, icon, disabled: !params.machineId,
            subtitle: !params.machineId || (probeEntry === entry && probe.probe.failed) ? t('walkthroughSettings.unavailable')
                : probeEntry === entry && probe.probe.phase !== 'idle' ? t('common.loading') : t('walkthroughSettings.chooseModel') });
        for (const profile of profiles) {
            const support = profile.structuredOutput;
            if (support === 'supported' && profile.modelSelector) selections.set(profile.catalogId, { backendTarget: target, modelSelector: profile.modelSelector });
            items.push({ id: profile.catalogId, title: profile.title, category: entry.title, icon, disabled: support !== 'supported',
                subtitle: support === 'supported' ? undefined : support === 'unsupported' ? t('walkthroughSettings.unsupported') : t('walkthroughSettings.unavailable') });
        }
    }
    const runtimeDefault = params.defaultBackendTarget;
    if (runtimeDefault) {
        const runtimeSelection = [...selections.values()].find(selection => selection.modelSelector.modelId === 'default'
            && buildBackendTargetKeyV2(selection.backendTarget) === buildBackendTargetKeyV2(runtimeDefault));
        if (runtimeSelection) selections.set('', runtimeSelection);
        items.unshift({ id: '', title: t('agentInput.model.useCliSettings'), disabled: !runtimeSelection,
            subtitle: runtimeSelection ? undefined : t('walkthroughSettings.unavailable') });
    }
    return { open, setOpen, discoveryTargetKey, setDiscoveryTargetKey, selections, discoveryTargets, items,
        selectedItem: items.find(item => item.id === params.value), selectionAvailable: selections.has(params.value),
        onRefresh: probe.probe.onRefresh };
}
