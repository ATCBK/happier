import * as React from 'react';
import { getAgentCore, getAgentStaticModels } from '@happier-dev/agents';
import { buildBackendTargetKeyV2, type BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ProviderBoundModelRefSchema } from '@happier-dev/protocol/providers/model-selection';
import { PluginBackendExecutionRunCapabilitiesV1Schema } from '@happier-dev/protocol/plugins/backendDefinitionV1';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useNewSessionPreflightModelsState } from '@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState';
import type { DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { useSetting } from '@/sync/domains/state/storage';
import { useAcpCatalogForServer } from '@/sync/store/useAcpCatalog';
import { decodeScmDiffSummaryModelOverride, encodeScmDiffSummaryModelOverride } from '@/settings/scmDiffSummary/settings';
import { t } from '@/text';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readScmDiffSummaryModelCatalogForMachine } from '@/sync/ops/actions/scmDiffSummarySettingsCatalog';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { ScmDiffSummaryModelCatalogObservationV1Schema } from '@happier-dev/protocol/actions/settings/scmDiffSummarySettings';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { projectAgentModelChoices, readAgentModelChoiceTarget as targetFor, type AgentModelChoicePurpose } from './projectAgentModelChoices';
export type { AgentModelSelection } from './projectAgentModelChoices';

/** One offered-model projection for Settings, the picker, and restored generation controls. */
export function useAgentModelChoices(params: Readonly<{
    value: string;
    purpose?: AgentModelChoicePurpose;
    machineId?: string | null;
    serverId?: string | null;
    defaultBackendTarget?: BackendTargetRefV2 | null;
    /** A mounted result still observes its selected model when its picker is hidden. */
    observeSelection?: boolean;
}>) {
    const [open, setOpen] = React.useState(false);
    const [discoveryTargetKey, setDiscoveryTarget] = React.useState<string | null>(null);
    const pendingDiscoveryTarget = React.useRef<string | null>(null);
    const setDiscoveryTargetKey = React.useCallback((targetKey: string | null) => {
        pendingDiscoveryTarget.current = targetKey;
        setDiscoveryTarget(targetKey);
    }, []);
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
    const purpose = params.purpose ?? 'walkthrough';
    const [summaryCatalog, setSummaryCatalog] = React.useState<Readonly<{
        lifetime: ServerAccountScopeLifetime;
        machineId: string; serverId: string; catalog: ReturnType<typeof ScmDiffSummaryModelCatalogObservationV1Schema.parse>;
    }> | null>(null);
    const [catalogRefresh, setCatalogRefresh] = React.useState(0);
    const summaryServerId = params.serverId || getActiveServerSnapshot().serverId;
    const catalogBindings = useServerCredentialAccountScopeBindings([summaryServerId]);
    const catalogLifetime = catalogBindings.values().next().value ?? null;
    React.useEffect(() => {
        if (purpose !== 'walkthrough' || !observing || !params.machineId || !catalogLifetime) return;
        const machineId = params.machineId;
        const abort = new AbortController();
        let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | null = null;
        void (async () => {
            try {
                account = await captureLazyActionAccountContext(summaryServerId, abort.signal);
                if (abort.signal.aborted || !catalogLifetime.isCurrent()) return;
                // A target stays selected for projection; only an explicit operation bypasses the Machine cache once.
                const requestedDiscoveryTarget = pendingDiscoveryTarget.current;
                pendingDiscoveryTarget.current = null;
                const catalog = await readScmDiffSummaryModelCatalogForMachine(account, machineId, abort.signal,
                    { discoveryTargetKey: requestedDiscoveryTarget, modelSelector: decodeScmDiffSummaryModelOverride(params.value) });
                if (!abort.signal.aborted && catalogLifetime.isCurrent()) setSummaryCatalog(catalog
                    ? { lifetime: catalogLifetime, machineId, serverId: summaryServerId, catalog } : null);
            } catch { if (!abort.signal.aborted) setSummaryCatalog(null); }
            finally { account?.dispose(); }
        })();
        return () => { abort.abort(); account?.dispose(); };
    }, [purpose, observing, params.machineId, params.value, summaryServerId, daemon.inputs, backendEnabledByTargetKey, catalogRefresh, discoveryTargetKey, catalogLifetime]);
    const executableCatalog = summaryCatalog && summaryCatalog.machineId === params.machineId && summaryCatalog.serverId === summaryServerId
        && summaryCatalog.lifetime === catalogLifetime && summaryCatalog.lifetime.isCurrent() ? summaryCatalog.catalog : null;
    const catalogInput = { executableProfiles: executableCatalog?.profiles, automaticProfiles: executableCatalog?.automaticProfiles,
        discoveryTargetKeys: executableCatalog?.discoveryTargetKeys };
    const selectedModelSelection = selected?.backendTargetKey && selected.modelId
        ? ProviderBoundModelRefSchema.parse({ agentTargetKey: selected.backendTargetKey, providerConnectionId: null, modelId: selected.modelId }) : null;
    const selectedEntry = entries.find((entry) => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === selected?.backendTargetKey;
    });
    const discoveryEntry = entries.find(entry => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === discoveryTargetKey;
    });
    const sources = entries.map(entry => {
        const staticModels = getAgentStaticModels(entry.agentId, { catalogOnly: true });
        const capability = entry.capabilities?.executionRun === undefined ? null
            : PluginBackendExecutionRunCapabilitiesV1Schema.safeParse(entry.capabilities.executionRun);
        const agentFormats = entry.kind === 'builtInAgent' ? getAgentCore(entry.agentId)?.structuredOutput?.formats : null;
        return { entry, models: staticModels, catalogModels: staticModels, agentFormats,
            runnerCapable: capability === null || (capability.success && capability.data.supported),
            discoverable: purpose === 'runner' || entry.kind === 'configuredBackend' || entry === discoveryEntry || entry === selectedEntry || agentFormats?.includes('json') === true };
    });
    const initialDefault = projectAgentModelChoices({ purpose, sources, ...catalogInput, selected: selectedModelSelection,
        defaultBackendTarget: params.defaultBackendTarget, defaultModelTitle: t('agentInput.model.useCliSettings') }).defaultProfile;
    const defaultEntry = entries.find(entry => {
        const target = targetFor(entry);
        return target && buildBackendTargetKeyV2(target) === initialDefault?.modelSelector?.backendTargetKey;
    });
    const probeEntry = discoveryEntry ?? selectedEntry ?? (!params.value ? defaultEntry : undefined);
    const probeTarget = probeEntry ? targetFor(probeEntry) : params.defaultBackendTarget;
    const probe = useNewSessionPreflightModelsState({ backendTarget: probeTarget,
        runtimeCarrierAgentId: probeEntry?.agentId, selectedMachineId: params.machineId ?? null,
        capabilityServerId: params.serverId ?? '',
        enabled: purpose === 'runner' && observing && Boolean(params.machineId) && (probeEntry?.kind !== 'configuredBackend' || catalogReady),
    });
    const projected = projectAgentModelChoices({ purpose, ...catalogInput, selected: selectedModelSelection,
        defaultBackendTarget: params.defaultBackendTarget, defaultModelTitle: t('agentInput.model.useCliSettings'),
        sources: sources.map(source => {
            const target = targetFor(source.entry);
            const key = target ? buildBackendTargetKeyV2(target) : null;
            const dynamic = key && probe.preflightModelsTargetKey === key ? probe.preflightModels : null;
            return { ...source, models: dynamic?.availableModels ?? source.models };
        }) });
    const { selections, catalogProfiles, defaultProfile } = projected;
    const discoveryTargets = new Map<string, string>();
    const customModelTargets = new Map<string, string>();
    const costTierLabels = { low: t('walkthroughSettings.costLow'), standard: t('walkthroughSettings.costStandard'), premium: t('walkthroughSettings.costPremium') } as const;
    const items: DropdownMenuItem[] = [];
    const sections: Record<string, Readonly<{ icon: React.ReactNode; note?: string }>> = {};
    for (const { entry, target, offered: usable, hiddenModelCount: hidden, discoverable, customModelIdAllowed } of projected.groups) {
        // Only models that can write a walkthrough are offered. An agent with none keeps its section only where a
        // machine can ask it for models that could: one whose format supports it, a configured agent, or the one asked.
        if (usable.length === 0 && !(params.machineId && discoverable)) continue;
        sections[entry.title] = { icon: React.createElement(AgentIcon, { agentId: entry.agentId, size: 18 }),
            ...(hidden > 0 ? { note: t('walkthroughSettings.hiddenModels', { count: hidden }) } : {}) };
        for (const profile of usable) {
            // One row per model; the default is that row, marked, and the quiet line carries the catalog's relative cost when it has one.
            const meta = [profile.catalogId === defaultProfile?.catalogId ? t('walkthroughSettings.defaultModel') : null,
                profile.costTier ? costTierLabels[profile.costTier] : null].filter(Boolean).join(' · ') || undefined;
            items.push({ id: profile.catalogId, title: profile.title, category: entry.title, subtitle: meta });
        }
        if (customModelIdAllowed) {
            const targetKey = buildBackendTargetKeyV2(target);
            const id = `backend-custom-model:${targetKey}`;
            customModelTargets.set(id, targetKey);
            items.push({ id, category: entry.title, title: t('settingsSession.replayResume.summaryRunner.customTitle'),
                subtitle: t('settingsSession.replayResume.summaryRunner.customModelIdSubtitle') });
        }
        // Finding more models is one operation at the end of its agent's section, offered only where a machine can answer it.
        if (!params.machineId || !discoverable) continue;
        const targetKey = buildBackendTargetKeyV2(target);
        const id = `backend-discovery:${targetKey}`;
        discoveryTargets.set(id, targetKey);
        const probing = probeEntry === entry;
        const failed = purpose === 'runner' && probing && probe.probe.failed;
        // The row keeps its height while discovery runs: only its trailing spinner and, on failure, its wording change.
        items.push({ id, category: entry.title, title: failed ? t('walkthroughSettings.loadModelsFailed') : t('walkthroughSettings.loadModels'),
            rightElement: purpose === 'runner' && probing && !failed && probe.probe.phase !== 'idle' ? React.createElement(ActivitySpinner, { size: 'small' }) : undefined });
    }
    const defaultSelection = defaultProfile ? selections.get(defaultProfile.catalogId) : undefined;
    // An unset choice follows the default: it resolves to that row's selection without writing it.
    if (defaultSelection && purpose === 'walkthrough') selections.set('', defaultSelection);
    const effectiveId = (selected ? encodeScmDiffSummaryModelOverride(selected) : params.value)
        || (purpose === 'walkthrough' && defaultSelection ? defaultProfile!.catalogId : '');
    const restoredSelection = selections.get(effectiveId);
    if (params.value && restoredSelection) selections.set(params.value, restoredSelection);
    return { open, setOpen, discoveryTargetKey, setDiscoveryTargetKey, selections, discoveryTargets, customModelTargets, items, sections,
        catalogProfiles, defaultProfile, groups: projected.groups,
        selectedItem: items.find(item => item.id === effectiveId), selectionAvailable: selections.has(params.value),
        onRefresh: purpose === 'walkthrough' ? () => setCatalogRefresh(value => value + 1) : probe.probe.onRefresh };
}
