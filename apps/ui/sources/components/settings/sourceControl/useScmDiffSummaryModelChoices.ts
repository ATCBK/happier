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
import { decodeScmDiffSummaryModelOverride, resolveScmDiffSummaryDefaultModelProfile, type ScmDiffSummaryCatalogProfile } from '@/settings/scmDiffSummary/settings';
import { buildScmDiffSummaryModelProfiles } from '@/settings/scmDiffSummary/models';
import { t } from '@/text';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

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
    const staticProfiles = entries.flatMap(entry => {
        const target = targetFor(entry);
        return target ? buildScmDiffSummaryModelProfiles({ backendTarget: target,
            models: getAgentStaticModels(entry.agentId, { catalogOnly: true }),
            agentFormats: entry.kind === 'builtInAgent' ? getAgentCore(entry.agentId)?.structuredOutput?.formats : null }) : [];
    });
    const initialDefault = resolveScmDiffSummaryDefaultModelProfile(staticProfiles, params.defaultBackendTarget);
    const defaultEntry = entries.find(entry => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === initialDefault?.modelSelector?.backendTargetKey;
    });
    const probeEntry = discoveryEntry ?? selectedEntry ?? (!params.value ? defaultEntry : undefined);
    const probeTarget = probeEntry ? targetFor(probeEntry) : params.defaultBackendTarget;
    const probe = useNewSessionPreflightModelsState({ backendTarget: probeTarget,
        runtimeCarrierAgentId: probeEntry?.agentId, selectedMachineId: params.machineId ?? null,
        capabilityServerId: params.serverId ?? '',
        enabled: observing && Boolean(params.machineId) && (probeEntry?.kind !== 'configuredBackend' || catalogReady),
    });
    const selections = new Map<string, ScmDiffSummaryModelSelection>();
    const discoveryTargets = new Map<string, string>();
    const catalogProfiles: ScmDiffSummaryCatalogProfile[] = [];
    const entryProfiles = entries.flatMap(entry => {
        const target = targetFor(entry);
        if (!target) return [];
        const dynamic = probeTarget && buildBackendTargetKeyV2(target) === buildBackendTargetKeyV2(probeTarget) && probe.preflightModels ? probe.preflightModels.availableModels : null;
        const staticModels = getAgentStaticModels(entry.agentId, { catalogOnly: true });
        const profiles = buildScmDiffSummaryModelProfiles({ backendTarget: target, models: dynamic ?? staticModels, catalogModels: staticModels,
            agentFormats: entry.kind === 'builtInAgent' ? getAgentCore(entry.agentId)?.structuredOutput?.formats : null });
        catalogProfiles.push(...profiles);
        return [{ entry, target, profiles }];
    });
    const defaultProfile = resolveScmDiffSummaryDefaultModelProfile(catalogProfiles, params.defaultBackendTarget);
    const costTierLabels = { low: t('walkthroughSettings.costLow'), standard: t('walkthroughSettings.costStandard'), premium: t('walkthroughSettings.costPremium') } as const;
    const items: DropdownMenuItem[] = [];
    const sections: Record<string, Readonly<{ icon: React.ReactNode; note?: string }>> = {};
    for (const { entry, target, profiles } of entryProfiles) {
        // Only models that can write a walkthrough are offered. An agent with none keeps its section only where a
        // machine can ask it for models that could: one whose format supports it, a configured agent, or the one asked.
        const usable = profiles.filter(profile => profile.structuredOutput === 'supported' && profile.modelSelector);
        const discoverable = entry.kind === 'configuredBackend' || entry === probeEntry
            || (entry.kind === 'builtInAgent' && getAgentCore(entry.agentId)?.structuredOutput?.formats?.includes('json') === true);
        if (usable.length === 0 && !(params.machineId && discoverable)) continue;
        const hidden = profiles.length - usable.length;
        sections[entry.title] = { icon: React.createElement(AgentIcon, { agentId: entry.agentId, size: 18 }),
            ...(hidden > 0 ? { note: t('walkthroughSettings.hiddenModels', { count: hidden }) } : {}) };
        for (const profile of usable) {
            selections.set(profile.catalogId, { backendTarget: target, modelSelector: profile.modelSelector! });
            // One row per model; the default is that row, marked, and the quiet line carries the catalog's relative cost when it has one.
            const meta = [profile.catalogId === defaultProfile?.catalogId ? t('walkthroughSettings.defaultModel') : null,
                profile.costTier ? costTierLabels[profile.costTier] : null].filter(Boolean).join(' · ') || undefined;
            items.push({ id: profile.catalogId, title: profile.title, category: entry.title, subtitle: meta });
        }
        // Finding more models is one operation at the end of its agent's section, offered only where a machine can answer it.
        if (!params.machineId) continue;
        const targetKey = buildBackendTargetKeyV2(target);
        const id = `backend-discovery:${targetKey}`;
        discoveryTargets.set(id, targetKey);
        const probing = probeEntry === entry;
        const failed = probing && probe.probe.failed;
        // The row keeps its height while discovery runs: only its trailing spinner and, on failure, its wording change.
        items.push({ id, category: entry.title, title: failed ? t('walkthroughSettings.loadModelsFailed') : t('walkthroughSettings.loadModels'),
            rightElement: probing && !failed && probe.probe.phase !== 'idle' ? React.createElement(ActivitySpinner, { size: 'small' }) : undefined });
    }
    const defaultSelection = defaultProfile ? selections.get(defaultProfile.catalogId) : undefined;
    // An unset choice follows the default: it resolves to that row's selection without writing it.
    if (defaultSelection) selections.set('', defaultSelection);
    const effectiveId = params.value || (defaultSelection ? defaultProfile!.catalogId : '');
    return { open, setOpen, discoveryTargetKey, setDiscoveryTargetKey, selections, discoveryTargets, items, sections,
        catalogProfiles, defaultProfile,
        selectedItem: items.find(item => item.id === effectiveId), selectionAvailable: selections.has(params.value),
        onRefresh: probe.probe.onRefresh };
}
