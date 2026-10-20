import * as React from 'react';
import type {
    DaemonPluginUiTargetedSurfaceMountV1,
    PreparedPluginJsonSchema,
} from '@happier-dev/protocol';
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
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
    pluginUiProjectionAdmissionTargetKey,
    savePluginUiProjectionTargetedAdmissionSnapshot,
} from '@/sync/domains/plugins/ui/projectionWarmCache';

/**
 * One targeted embedded-Surface mount plus its prepared input validator and
 * Protocol normalizer. This is host-private executable state derived from one
 * target read response; it is never itself an RPC projection.
 */
export type PreparedDaemonPluginUiTargetedSurfaceMountV1 = Readonly<
    Omit<DaemonPluginUiTargetedSurfaceMountV1, 'inputSchema'> & {
        /** The canonical schema identity paired with `inputValidation`. */
        inputSchema: PreparedPluginJsonSchema['jsonSchema'];
        inputValidation: PreparedPluginJsonSchema;
        /** The sole Protocol rehydrator restores this target-owned normalizer. */
        inputNormalizer: NonNullable<ReturnType<typeof rehydrateCanonicalProtocolComposableSchema>>;
    }
>;

/**
 * Prepares each mount's input validator. A mount whose role schema is not
 * Protocol-canonical, or cannot be compiled, gets no physical child mount;
 * the rest of the response is unaffected.
 */
export function prepareTargetedSurfaceMounts(
    mounts: readonly DaemonPluginUiTargetedSurfaceMountV1[],
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
    failure: MountedTargetedContributionsFailure | null;
}>;

const IDLE_STATE: MountedTargetedContributionsState = Object.freeze({
    phase: 'idle',
    targetedContributions: null,
    preparedTargetedSurfaceMounts: null,
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
    machineId: string | null | undefined;
    serverId: string | null | undefined;
    pluginId: string | null | undefined;
    /** The occurrence the mount was built from; a change re-reads. */
    mountedOccurrenceId: string | null | undefined;
    enabled: boolean;
    refreshKey?: unknown;
}>): MountedTargetedContributionsState {
    const machineId = normalizeKeyPart(params.machineId);
    const serverId = normalizeKeyPart(params.serverId);
    const pluginId = normalizeKeyPart(params.pluginId);
    const mountedOccurrenceId = normalizeKeyPart(params.mountedOccurrenceId);
    const active = params.enabled && Boolean(machineId) && Boolean(pluginId);
    const accountLifetime = active ? captureActiveServerAccountScopeLifetime() : null;
    const projectionScope = React.useMemo(() => (
        active ? { machineId, serverId: serverId || null } : null
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
    const targetKey = active ? JSON.stringify([serverId, machineId, pluginId]) : '';
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
                    failure: null,
                },
            };
        });
        const isCurrent = () => alive && accountLifetime.isCurrent();
        void machinePluginUiTargetedContributionsRead(machineId, {
            serverId: serverId || null,
            pluginId,
            accountLifetime,
            signal: abort.signal,
        }).then((result) => {
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
            // Recorded for the next fresh process: an offline mount may show
            // the last confirmed admission read-only.
            savePluginUiProjectionTargetedAdmissionSnapshot({
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
            setLoaded((previous) => previous.requestKey !== targetKey
                || previous.accountLifetime !== accountLifetime
                ? previous
                : {
                    ...previous,
                    state: {
                        phase: 'ready',
                        targetedContributions: result.targetedContributions,
                        preparedTargetedSurfaceMounts,
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
        active,
        machineId,
        mountedOccurrenceId,
        params.refreshKey,
        pluginId,
        projectionRevision,
        projectionScope,
        serverId,
        targetKey,
    ]);

    if (!active) return IDLE_STATE;
    if (!accountLifetime || !accountLifetime.isCurrent()) return LOADING_STATE;
    if (loaded.requestKey !== targetKey || loaded.accountLifetime !== accountLifetime) {
        return LOADING_STATE;
    }
    return loaded.state;
}
