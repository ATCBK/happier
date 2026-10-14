import * as React from 'react';
import { arePluginMachineExecutionOriginsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PluginContributionIdentityV1Schema } from '@happier-dev/protocol/plugins/contribution-identity';
import { type PluginUiResourceBindingCapabilityV1 } from '@happier-dev/protocol';

import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { useActivePluginAccountAvailabilityReleaseClassifier } from '@/sync/domains/plugins/availability/projection';
import { usePluginMachineExecutionOriginSelection } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { createPluginUiProjectedActionResolver, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionSupplies, readPluginUiExecutionOriginCandidates } from '@/sync/domains/plugins/ui/projectionUnion';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getPluginExecutionOriginCandidateOrigin, type PluginExecutionOriginContextualTarget } from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { resolvePluginUiProjectionContributionId } from '@/sync/domains/plugins/ui/projectionRefs';
import { readRequiredPluginSurfaceHostMethods } from './boundPluginSurfaceController';

function record(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
}

/** Declared machine-backed capabilities, not execution availability or a selector policy. */
export function isPluginSurfaceMachineBound(params: Readonly<{
    pluginId: string;
    renderer: Readonly<Record<string, unknown>>;
    projection: PluginUiProjectionModel | null | undefined;
    headerActions?: unknown;
    resourceCapability?: PluginUiResourceBindingCapabilityV1;
}>): boolean {
    const family = params.renderer.kind === 'reactNative' ? 'reactNativeBundle'
        : params.renderer.kind === 'hostedWeb' ? 'hostedWeb' : null;
    const artifacts = family === 'reactNativeBundle' ? params.projection?.reactNativeBundlesById
        : family === 'hostedWeb' ? params.projection?.hostedWebById : null;
    const artifactId = family ? resolvePluginUiProjectionContributionId({ family, pluginId: params.pluginId,
        contributionId: params.renderer.contributionId, entriesById: artifacts ?? {} }) : null;
    const artifact = artifactId ? artifacts?.[artifactId] : null;
    const methods = readRequiredPluginSurfaceHostMethods(params.renderer.requiredHostMethods
        ?? record(params.renderer.model)?.requiredHostMethods ?? artifact?.requiredHostMethods);
    if (methods === null) return false;
    // Mounted contribution points are read from the selected daemon even when
    // its renderer can also present Account data without required host methods.
    if (params.projection?.installedPackagesById[params.pluginId]?.declaresContributionPoints === true) return true;
    // The same Resource methods also serve Account-owned borrowed host reads.
    // Only the selected member's declared daemon Resource capability implies a target.
    // requiredHostMethods is the renderer's compatibility minimum, not an
    // inventory of the selected member's declared daemon Resource reads.
    if (params.resourceCapability?.readable === true) return true;
    if (methods.some(method => method === 'readStoredImage' || method === 'watchLiveStream'
        || method === 'statOpenableContent' || method === 'readOpenableContent'
        || method === 'selectActionInput')) return true;
    const actions = Object.values(params.projection?.actionsById ?? {});
    if (methods.includes('executeAction') && actions.some(action => action.pluginId === params.pluginId
        && action.execution.target === 'daemon')) return true;
    return Array.isArray(params.headerActions) && params.headerActions.some(action => {
        const command = record(record(action)?.command);
        const identity = PluginContributionIdentityV1Schema.safeParse(command?.action);
        return command?.kind === 'executeAction' && identity.success
            && createPluginUiProjectedActionResolver(params.projection?.actionsById)(identity.data)?.execution.target === 'daemon';
    });
}

/** Presentation adapts producer custody; Administration remains the sole selector. */
export function usePluginSurfaceExecutionOrigin(params: Readonly<{
    pluginId: string;
    projection: PluginUiProjectionModel | null | undefined;
    entry?: Readonly<{ id: string }> | null;
    enabled: boolean;
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
}>) {
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
    // Selection is plugin-scoped, just like the shell's Administration
    // reporter. The open page narrows only the selected producer's supply,
    // never the candidates or defaults used to choose that producer.
    const supplied = React.useMemo(() => readPluginUiExecutionOriginCandidates({
        projection: params.projection ?? null, pluginId: params.pluginId,
    }), [params.pluginId, params.projection]);
    const readCurrentCandidates = React.useCallback(() => readPluginUiExecutionOriginCandidates({
        projection: readCurrentAppShellPluginUiProjection(), pluginId: params.pluginId,
    }), [params.pluginId]);
    const readSourceCandidates = React.useCallback(() => readCurrentCandidates().sourceCandidates, [readCurrentCandidates]);
    const readDeclaredDefaultOrigins = React.useCallback(() => readCurrentCandidates().declaredDefaultOrigins, [readCurrentCandidates]);
    const selection = usePluginMachineExecutionOriginSelection({
        pluginId: params.pluginId, enabled: params.enabled, classifyRelease,
        ...supplied, readSourceCandidates, readDeclaredDefaultOrigins,
        contextualTarget: params.contextualTarget,
    });
    const selectedSupplyFromSelection = React.useMemo(() => selection.selectedOrigin
        ? readPluginUiContributionSupplies(params.entry).find(supply => supply.executionOrigin
            && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, selection.selectedOrigin!)) ?? null
        : null, [params.entry, selection.selectedOrigin]);
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const lastSelectedSupply = React.useRef<Readonly<{
        accountLifetime: typeof accountLifetime;
        entryId: string;
        supply: NonNullable<typeof selectedSupplyFromSelection>;
    }> | null>(null);
    const previous = lastSelectedSupply.current;
    // Presence/projection readiness can withdraw execution without replacing
    // the admitted producer. Retain only its exact presentation identity;
    // invocation still resolves fresh Administration authority below.
    const offlineCandidate = previous?.supply.executionOrigin && selection.state.kind === 'unavailable'
        ? selection.candidates.find(candidate => arePluginMachineExecutionOriginsEqual(
            getPluginExecutionOriginCandidateOrigin(candidate), previous.supply.executionOrigin!,
        )) : null;
    const canRetainSupply = params.enabled && accountLifetime?.isCurrent() === true
        && previous?.accountLifetime === accountLifetime && previous.entryId === params.entry?.id
        && (!selection.selectedOrigin || arePluginMachineExecutionOriginsEqual(selection.selectedOrigin, previous.supply.executionOrigin!))
        && offlineCandidate?.validation.kind === 'rejected'
        && (offlineCandidate.validation.reason === 'offline' || offlineCandidate.validation.reason === 'stale');
    const retainedSupply = canRetainSupply ? readPluginUiContributionSupplies(params.entry).find(supply => (
        supply.executionOrigin && previous?.supply.executionOrigin
        && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, previous.supply.executionOrigin)
        && supply.occurrenceId === previous.supply.occurrenceId
        && supply.generation === previous.supply.generation
        && supply.pluginVersion === previous.supply.pluginVersion
        && supply.serverId === previous.supply.serverId
    )) ?? null : null;
    const selectedSupply = selectedSupplyFromSelection ?? retainedSupply;
    React.useLayoutEffect(() => {
        if (selection.canExecute && selectedSupplyFromSelection && params.entry && accountLifetime?.isCurrent()) {
            lastSelectedSupply.current = { accountLifetime, entryId: params.entry.id, supply: selectedSupplyFromSelection };
        } else if (!retainedSupply) {
            lastSelectedSupply.current = null;
        }
    }, [accountLifetime, params.entry, retainedSupply, selectedSupplyFromSelection, selection.canExecute]);
    const isExecutionOriginCurrent = React.useCallback(() => {
        const fresh = selection.resolveExecutionOrigin();
        if (!fresh || !selectedSupply?.executionOrigin || !selectedSupply.occurrenceId
            || selectedSupply.phase !== 'current' || !selectedSupply.interactionEnabled
            || !arePluginMachineExecutionOriginsEqual(fresh.origin, selectedSupply.executionOrigin)) return false;
        const projection = readCurrentAppShellPluginUiProjection();
        const entry = params.entry && projection
            ? projection.surfacePlacementsById[params.entry.id] ?? projection.settingsPagesById[params.entry.id]
            : null;
        return readPluginUiContributionSupplies(entry).some(supply => (
                supply.executionOrigin && arePluginMachineExecutionOriginsEqual(supply.executionOrigin, fresh.origin)
                && supply.occurrenceId === selectedSupply.occurrenceId
                && supply.generation === selectedSupply.generation
                && supply.serverId === selectedSupply.serverId
                && supply.phase === 'current' && supply.interactionEnabled
            ));
    }, [params.entry, selectedSupply, selection.resolveExecutionOrigin]);
    return { selection, selectedSupply, isExecutionOriginCurrent };
}
