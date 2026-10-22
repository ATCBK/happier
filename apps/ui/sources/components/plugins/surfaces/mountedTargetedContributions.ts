import * as React from 'react';
import { isPluginError } from '@happier-dev/plugin-sdk';
import type {
    DaemonPluginUiTargetedSurfaceMountV1,
    PreparedPluginJsonSchema,
} from '@happier-dev/protocol';
import type { PluginUiTargetedSurfaceMountCoreV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiAccountExecutableOrigin } from '../reactNative/executableModuleHost';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { readMountedAccountTargetedContributions } from './mountedAccountTargetedContributions';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import {
    readCachedDaemonMergedProjectionCacheEntry,
    subscribeDaemonMergedProjectionSummary,
    type DaemonMergedProjectionInputs,
} from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { createInstalledPluginUiProjectionPublication } from '@/sync/domains/plugins/ui/projectionUnion';
import { createPluginActionInputSelectionFactsPublication, readPluginActionInputSelectionPresenceSnapshot, type PluginActionInputSelectionSnapshot } from './pluginActionInputSelectionFacts';

import {
    preparePluginJsonSchema,
    rehydrateCanonicalProtocolComposableSchema,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';

import {
    getMachineContributionRegistryProjectionRevision,
    machinePluginUiTargetedContributionsRead,
    publishMachineContributionRegistryProjectionInvalidation,
    subscribeMachineContributionRegistryProjectionInvalidation,
    type MachinePluginUiTargetedContributionsReadResult,
} from '@/sync/ops/machineContributionRegistryProjection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    pluginUiProjectionAdmissionTargetKey,
    readPluginUiProjectionAdmissionSnapshot,
    savePluginUiProjectionTargetedAdmissionSnapshot,
} from '@/sync/domains/plugins/ui/projectionWarmCache';

export type MountedPluginUiTargetedSurfaceMountV1 = Readonly<DaemonPluginUiTargetedSurfaceMountV1 & {
    accountExecutionOrigin?: never;
}> | Readonly<
    PluginUiTargetedSurfaceMountCoreV1 & {
        accountExecutionOrigin: PluginUiAccountExecutableOrigin;
        executionOrigin?: never;
    }
>;

/**
 * One targeted embedded-Surface mount plus its prepared input validator and
 * Protocol normalizer. This is host-private executable state derived from one
 * target read response; it is never itself an RPC projection.
 */
type PreparedTargetedSurfaceMount<TMount> = TMount extends MountedPluginUiTargetedSurfaceMountV1 ? Readonly<
    Omit<TMount, 'inputSchema'> & {
        /** The canonical schema identity paired with `inputValidation`. */
        inputSchema: PreparedPluginJsonSchema['jsonSchema'];
        inputValidation: PreparedPluginJsonSchema;
        /** The sole Protocol rehydrator restores this target-owned normalizer. */
        inputNormalizer: NonNullable<ReturnType<typeof rehydrateCanonicalProtocolComposableSchema>>;
        /** Joined with current catalog/text by this target's source publication. */
        actionInputSelectionFactsKey?: PluginActionInputSelectionSnapshot;
    }
> : never;

export type PreparedDaemonPluginUiTargetedSurfaceMountV1 = PreparedTargetedSurfaceMount<MountedPluginUiTargetedSurfaceMountV1>;

/**
 * Prepares each mount's input validator. A mount whose role schema is not
 * Protocol-canonical, or cannot be compiled, gets no physical child mount;
 * the rest of the response is unaffected.
 */
export function prepareTargetedSurfaceMounts(
    mounts: readonly MountedPluginUiTargetedSurfaceMountV1[],
): readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[] {
    const prepared: PreparedDaemonPluginUiTargetedSurfaceMountV1[] = [];
    for (const mount of mounts) {
        try {
            const inputNormalizer = rehydrateCanonicalProtocolComposableSchema(mount.inputSchema);
            if (!inputNormalizer) continue;
            const inputValidation = preparePluginJsonSchema(inputNormalizer.jsonSchema);
            prepared.push(Object.freeze({
                ...mount,
                inputSchema: inputValidation.jsonSchema,
                inputValidation,
                inputNormalizer,
            }));
        } catch {
            // No fallback validator or renderer exists for an invalid mount.
        }
    }
    return Object.freeze(prepared);
}

export type MountedTargetedContributionsFailure = Readonly<{
    reason: Exclude<MachinePluginUiTargetedContributionsReadResult, { supported: true }>['reason'];
    code?: string;
}>;

export type MountedTargetedContributionsState = Readonly<{
    /**
     * `loading` keeps the last current snapshot visible while a refresh runs;
     * `failed` carries the classified reason so a fallback can say why.
     */
    phase: 'idle' | 'loading' | 'ready' | 'failed';
    targetedContributions: PluginUiTargetedContributionsV1 | null;
    preparedTargetedSurfaceMounts: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[] | null;
    /** Exact ready Machine inputs paired atomically with this source publication. */
    projectionInputs: DaemonMergedProjectionInputs | null;
    /** Already normalized/composed before the mounted host reads it. */
    pluginUiProjection: PluginUiProjectionModel | null;
    actionInputSelectionFactsKey: PluginActionInputSelectionSnapshot;
    failure: MountedTargetedContributionsFailure | null;
}>;

const IDLE_STATE: MountedTargetedContributionsState = Object.freeze({
    phase: 'idle',
    targetedContributions: null,
    preparedTargetedSurfaceMounts: null,
    projectionInputs: null,
    pluginUiProjection: null,
    actionInputSelectionFactsKey: readPluginActionInputSelectionPresenceSnapshot({ hasPluginProjection: false, hasTargetedContributions: false }),
    failure: null,
});

const LOADING_STATE: MountedTargetedContributionsState = Object.freeze({
    ...IDLE_STATE,
    phase: 'loading',
});

type LoadedState = Readonly<{
    requestKey: string;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    state: MountedTargetedContributionsState;
}>;

function normalizeKeyPart(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

/**
 * The one owner of a mounted target's current contributions. It reads only
 * the target slice; the mount takes everything else from the per-machine
 * projection it already holds. It re-reads when the machine projection is
 * invalidated, when the mounted occurrence changes, or on an explicit retry.
 * The answer is the daemon's current snapshot tagged with its occurrence,
 * which the caller compares with the occurrence it mounted.
 */
export function useMountedTargetedContributions(params: Readonly<{
    /** The exact lifetime already acquired by the mounted Host/controller. */
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    machineId: string | null | undefined;
    serverId: string | null | undefined;
    pluginId: string | null | undefined;
    /** The occurrence the mount was built from; a change re-reads. */
    mountedOccurrenceId: string | null | undefined;
    enabled: boolean;
    refreshKey?: unknown;
    accountExecutionOrigin?: PluginUiAccountExecutableOrigin;
}>): MountedTargetedContributionsState {
    const machineId = normalizeKeyPart(params.machineId);
    const serverId = normalizeKeyPart(params.serverId);
    const pluginId = normalizeKeyPart(params.pluginId);
    const mountedOccurrenceId = normalizeKeyPart(params.mountedOccurrenceId);
    const accountOriginKey = JSON.stringify(params.accountExecutionOrigin ?? null);
    const accountOrigin = React.useMemo(() => params.accountExecutionOrigin, [accountOriginKey]);
    const active = params.enabled && Boolean(machineId || accountOrigin) && Boolean(pluginId);
    const accountLifetime = active ? params.accountLifetime : null;
    const accountAvailability = React.useMemo(() => accountLifetime
        ? readPluginAccountAvailability(accountLifetime.scope) : null, [accountLifetime]);
    const [accountRevision, refreshAccount] = React.useReducer((revision: number) => revision + 1, 0);
    const projectionScope = React.useMemo(() => (
        active && machineId ? { machineId, serverId: serverId || null } : null
    ), [active, machineId, serverId]);
    const subscribe = React.useCallback((listener: () => void) => (
        projectionScope
            ? subscribeMachineContributionRegistryProjectionInvalidation(projectionScope, listener)
            : () => {}
    ), [projectionScope]);
    const getRevision = React.useCallback(() => (
        projectionScope ? getMachineContributionRegistryProjectionRevision(projectionScope) : 0
    ), [projectionScope]);
    const projectionRevision = React.useSyncExternalStore(subscribe, getRevision, getRevision);
    // The target identity. Revision, occurrence and retry only ask again; they
    // never discard the snapshot this target already showed.
    const targetKey = active ? JSON.stringify([serverId, machineId, pluginId, accountOrigin ?? null]) : '';
    // A read tagged with a newer occurrence than the mount means the plugin
    // reloaded and the machine projection has not caught up. Ask it once per
    // (mounted, current) pair to refresh; the mount then follows the new
    // occurrence instead of showing an error.
    const followedOccurrenceRef = React.useRef<string | null>(null);
    const [loaded, setLoaded] = React.useState<LoadedState>(() => ({
        requestKey: '',
        accountLifetime: null,
        state: IDLE_STATE,
    }));
    const installedPublication = React.useMemo(
        () => createInstalledPluginUiProjectionPublication(),
        [accountLifetime, targetKey],
    );
    const targetPublication = React.useMemo<{
        current: PluginUiTargetedContributionsV1 | null;
        retainedPresentation: PluginUiProjectionModel | null;
    }>(
        () => ({ current: null, retainedPresentation: null }), [accountLifetime, targetKey],
    );
    const selectionPublication = React.useMemo(() => createPluginActionInputSelectionFactsPublication(), [accountLifetime, targetKey]);
    const childPublications = React.useMemo<{
        entries: Array<{ mount: PreparedDaemonPluginUiTargetedSurfaceMountV1; selection: ReturnType<typeof createPluginActionInputSelectionFactsPublication> }>;
        snapshot: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[] | null;
    }>(() => ({ entries: [], snapshot: null }), [accountLifetime, targetKey]);
    const readCurrentSources = React.useCallback((): Pick<MountedTargetedContributionsState, 'projectionInputs' | 'pluginUiProjection' | 'actionInputSelectionFactsKey' | 'preparedTargetedSurfaceMounts'> => {
        if (!accountLifetime?.isCurrent()) return { projectionInputs: null, pluginUiProjection: null, actionInputSelectionFactsKey: IDLE_STATE.actionInputSelectionFactsKey,
            preparedTargetedSurfaceMounts: null };
        const entry = projectionScope ? readCachedDaemonMergedProjectionCacheEntry(projectionScope) : null;
        const projectionInputs = entry?.accountCurrentness?.isCurrent()
            && areServerAccountScopesEqual(entry.accountScope ?? null, accountLifetime.scope)
            && (entry.kind === 'ready' || entry.kind === 'error')
            ? entry.inputs ?? null : null;
        if (projectionInputs || entry?.kind === 'unsupported') targetPublication.retainedPresentation = null;
        // Retained text is only presentation. The absent live input map still
        // refuses selectors/Actions; no retained schema gains authority.
        const runtime = projectionInputs?.pluginUiProjection ?? targetPublication.retainedPresentation;
        const account = accountAvailability?.readAccountUiProjection() ?? null;
        const pluginUiProjection = installedPublication.publish(account ? [account] : [], runtime);
        let childrenChanged = false;
        for (const child of childPublications.entries) {
            const actionInputSelectionFactsKey = child.selection.publish({ pluginProjectionById: projectionInputs?.pluginProjectionById,
                translationsByPluginId: pluginUiProjection?.translationsByPluginId,
                targetedContributions: child.mount.contributorTargetedContributions, targetPluginId: child.mount.contributor?.pluginId });
            if (child.mount.actionInputSelectionFactsKey !== actionInputSelectionFactsKey) {
                child.mount = Object.freeze({ ...child.mount, actionInputSelectionFactsKey });
                childrenChanged = true;
            }
        }
        if (childrenChanged) childPublications.snapshot = Object.freeze(childPublications.entries.map(child => child.mount));
        return {
            projectionInputs,
            pluginUiProjection,
            preparedTargetedSurfaceMounts: childPublications.snapshot,
            actionInputSelectionFactsKey: selectionPublication.publish({ pluginProjectionById: projectionInputs?.pluginProjectionById,
                translationsByPluginId: pluginUiProjection?.translationsByPluginId,
                targetedContributions: targetPublication.current, targetPluginId: pluginId }),
        };
    }, [accountAvailability, accountLifetime, childPublications, installedPublication, pluginId, projectionScope, selectionPublication, targetPublication]);

    React.useEffect(() => {
        if (!active || !accountLifetime) return;
        // Source notifications derive first, then publish one ready pair. React
        // state updaters and render/getSnapshot only read the prepared result.
        const updateSources = () => {
            const next = readCurrentSources();
            setLoaded(previous => previous.requestKey !== targetKey || previous.accountLifetime !== accountLifetime
                || (previous.state.projectionInputs === next.projectionInputs && previous.state.pluginUiProjection === next.pluginUiProjection
                    && previous.state.actionInputSelectionFactsKey === next.actionInputSelectionFactsKey
                    && previous.state.preparedTargetedSurfaceMounts === next.preparedTargetedSurfaceMounts)
                ? previous : { ...previous, state: { ...previous.state, ...next } });
        };
        const unsubscribeProjection = projectionScope
            ? subscribeDaemonMergedProjectionSummary(projectionScope, updateSources) : () => {};
        const unsubscribeAccount = accountAvailability?.subscribe(() => {
            updateSources();
            if (accountOrigin) refreshAccount();
        });
        const retirement = accountLifetime.onRetire(updateSources);
        updateSources();
        return () => { unsubscribeProjection(); unsubscribeAccount?.(); retirement.dispose(); };
    }, [accountAvailability, accountLifetime, accountOrigin, active, projectionScope, readCurrentSources, targetKey]);

    React.useEffect(() => {
        if (!active || !accountLifetime) return;
        let alive = true;
        const abort = new AbortController();
        const retirement = accountLifetime.onRetire(() => abort.abort());
        setLoaded((previous) => {
            const sameTarget = previous.requestKey === targetKey
                && previous.accountLifetime === accountLifetime;
            return {
                requestKey: targetKey,
                accountLifetime,
                state: {
                    phase: 'loading',
                    targetedContributions: sameTarget ? previous.state.targetedContributions : null,
                    preparedTargetedSurfaceMounts: sameTarget
                        ? previous.state.preparedTargetedSurfaceMounts
                        : null,
                    projectionInputs: sameTarget ? previous.state.projectionInputs : null,
                    pluginUiProjection: sameTarget ? previous.state.pluginUiProjection : null,
                    actionInputSelectionFactsKey: sameTarget ? previous.state.actionInputSelectionFactsKey : IDLE_STATE.actionInputSelectionFactsKey,
                    failure: null,
                },
            };
        });
        const isCurrent = () => alive && accountLifetime.isCurrent();
        const read = accountOrigin
            ? readMountedAccountTargetedContributions({ pluginId, origin: accountOrigin, accountLifetime,
                signal: abort.signal, isCurrent,
                ...(machineId ? { machine: { machineId, serverId: serverId || null } } : {}),
            }).catch((error: unknown) => ({ supported: false as const, reason: 'unavailable' as const,
                code: isPluginError(error) ? error.code : 'plugin_targeted_contributions_unavailable' }))
            : machinePluginUiTargetedContributionsRead(machineId, {
                serverId: serverId || null, pluginId, accountLifetime, signal: abort.signal,
            });
        void read.then((result) => {
            if (!isCurrent()) return;
            if (!result.supported) {
                setLoaded((previous) => previous.requestKey !== targetKey
                    || previous.accountLifetime !== accountLifetime
                    ? previous
                    : {
                        ...previous,
                        state: {
                            ...previous.state,
                            phase: 'failed',
                            failure: Object.freeze({
                                reason: result.reason,
                                ...(result.code ? { code: result.code } : {}),
                            }),
                        },
                    });
                return;
            }
            if (!accountOrigin) {
                if (!targetPublication.current) {
                    // Capture before this fresh read writes target admission:
                    // that write cannot relabel older text as a new source.
                    targetPublication.retainedPresentation = readPluginUiProjectionAdmissionSnapshot({
                        scope: accountLifetime.scope,
                        targetKey: pluginUiProjectionAdmissionTargetKey({ machineId, serverId: serverId || null }),
                        machineId,
                        target: result.targetedContributions.target,
                    });
                } else if (!sameStrictJsonValue(targetPublication.current.target, result.targetedContributions.target)) {
                    targetPublication.retainedPresentation = null;
                }
            }
            // Recorded for the next fresh process: an offline mount may show
            // the last confirmed admission read-only.
            if (!accountOrigin) savePluginUiProjectionTargetedAdmissionSnapshot({
                scope: accountLifetime.scope,
                targetKey: pluginUiProjectionAdmissionTargetKey({
                    machineId,
                    serverId: serverId || null,
                }),
                machineId,
                targetedContributions: result.targetedContributions,
            });
            const currentOccurrenceId = result.targetedContributions.target.occurrenceId;
            if (mountedOccurrenceId && currentOccurrenceId !== mountedOccurrenceId && projectionScope) {
                const pair = `${mountedOccurrenceId}\0${currentOccurrenceId}`;
                if (followedOccurrenceRef.current !== pair) {
                    followedOccurrenceRef.current = pair;
                    publishMachineContributionRegistryProjectionInvalidation(projectionScope);
                }
            }
            const preparedTargetedSurfaceMounts = prepareTargetedSurfaceMounts(result.targetedSurfaceMounts);
            const previousChildren = childPublications.entries;
            childPublications.entries = preparedTargetedSurfaceMounts.map(mount => ({ mount,
                selection: previousChildren.find(child => child.mount.contributor?.pluginId === mount.contributor?.pluginId
                    && child.mount.contributor?.contributionId === mount.contributor?.contributionId
                    && child.mount.contributor?.occurrenceId === mount.contributor?.occurrenceId
                    && child.mount.role === mount.role)?.selection ?? createPluginActionInputSelectionFactsPublication() }));
            childPublications.snapshot = preparedTargetedSurfaceMounts;
            const ownedTarget = projectNativeJsonValueForTransport(result.targetedContributions) as PluginUiTargetedContributionsV1;
            const targetedContributions = sameStrictJsonValue(targetPublication.current, ownedTarget)
                ? targetPublication.current : ownedTarget;
            targetPublication.current = targetedContributions;
            const sources = readCurrentSources();
            setLoaded((previous) => previous.requestKey !== targetKey
                || previous.accountLifetime !== accountLifetime
                ? previous
                : {
                    ...previous,
                    state: {
                        phase: 'ready',
                        targetedContributions,
                        ...sources,
                        failure: null,
                    },
                });
        });
        return () => {
            alive = false;
            abort.abort();
            retirement.dispose();
        };
    }, [
        accountLifetime,
        accountOrigin,
        accountRevision,
        active,
        childPublications,
        machineId,
        mountedOccurrenceId,
        params.refreshKey,
        pluginId,
        projectionRevision,
        projectionScope,
        readCurrentSources,
        serverId,
        targetKey,
        targetPublication,
    ]);

    if (!active) return IDLE_STATE;
    if (!accountLifetime || !accountLifetime.isCurrent()) return LOADING_STATE;
    if (loaded.requestKey !== targetKey || loaded.accountLifetime !== accountLifetime) {
        return LOADING_STATE;
    }
    return loaded.state;
}
