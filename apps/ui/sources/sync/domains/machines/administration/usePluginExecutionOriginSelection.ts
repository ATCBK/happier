import * as React from 'react';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { type PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { loadMachineDisplayWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import {
    resolveAllProfileMachineInventorySnapshots,
    type ServerMachineInventorySnapshotV1,
} from '@/sync/domains/machines/machineInventorySnapshots';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { getStorage, storage } from '@/sync/domains/state/storageStore';
import { useSetting, useSettingsVersion } from '@/sync/store/hooks';
import {
    type OneShotAccountSettingsMutationResult,
} from '@/sync/engine/settings/syncSettings';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';

import {
    clearPluginMachineExecutionOriginPreference,
    persistMachineAdministrationSelectionMutation,
    setPluginMachineExecutionOriginPreference,
} from './selectionPreferences';
import {
    buildPluginMachineExecutionOriginCandidates,
    buildPluginMachineSourceExecutionOriginCandidates,
    combinePluginMachineExecutionOriginCandidates,
    resolvePluginMachineExecutionOriginState,
    serializePluginMachineExecutionOriginMachineFacts,
    type PluginMachineExecutionOriginStateV1,
    type PluginMachineReleaseClassificationV1,
    type PluginMachineSourceExecutionOriginCandidateV1,
    type PluginExecutionOriginCandidateV1,
} from './pluginExecutionOrigin';
import { areAccountSettingsScopesEqual } from '@/sync/domains/settings/scope/accountSettingsScope';
import { buildMachineAdministrationCandidatesFromSnapshots } from './targetState';
import type { MachineAdministrationCandidateV1 } from './targetSelection';
import {
    resolveFreshMachineAdministrationExecutionTarget,
    type FreshMachineAdministrationExecutionTargetV1,
} from './useTargetSelection';

export type FreshPluginMachineExecutionOriginV1 = Readonly<{
    origin: PluginMachineExecutionOriginV1;
    materialization?: PluginMachineMaterializationV1;
    source?: PluginMachineSourceExecutionOriginCandidateV1['source'];
    machineTarget: FreshMachineAdministrationExecutionTargetV1;
    /** UI-local fence for origin selection changes, including A -> B -> A. */
    selectionRevision?: number;
}>;

type PluginExecutionOriginSelectionRevisionState = Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    revision: number;
}>;

const EMPTY_EXECUTION_ORIGIN_MACHINE_SNAPSHOTS: readonly ServerMachineInventorySnapshotV1[] = Object.freeze([]);
const DISABLED_EXECUTION_ORIGIN_MACHINE_SNAPSHOT_SELECTION = Object.freeze({
    key: '',
    snapshots: EMPTY_EXECUTION_ORIGIN_MACHINE_SNAPSHOTS,
});

type StorageState = ReturnType<typeof storage.getState>;

let cachedServerProfiles: Readonly<{
    generation: number;
    profiles: ReturnType<typeof listServerProfiles>;
}> | null = null;

let cachedExecutionOriginMachineSnapshots: Readonly<{
    profiles: ReturnType<typeof listServerProfiles>;
    activeServerId: string;
    accountId: string;
    isDataReady: boolean;
    machines: StorageState['machines'];
    machineListByServerId: StorageState['machineListByServerId'];
    machineListStatusByServerId: StorageState['machineListStatusByServerId'];
    snapshots: readonly ServerMachineInventorySnapshotV1[];
}> | null = null;

function readServerProfilesForGeneration(generation: number): ReturnType<typeof listServerProfiles> {
    if (cachedServerProfiles?.generation === generation) return cachedServerProfiles.profiles;
    const profiles = listServerProfiles();
    cachedServerProfiles = { generation, profiles };
    return profiles;
}

/**
 * All app-shell plugin selectors observe the same raw inventory update. Resolve
 * that canonical projection once per store snapshot instead of once per plugin.
 */
function readExecutionOriginMachineSnapshots(params: Readonly<{
    activeServerId: string;
    profilesGeneration: number;
    state: StorageState;
}>): readonly ServerMachineInventorySnapshotV1[] {
    const profiles = readServerProfilesForGeneration(params.profilesGeneration);
    const accountId = String(params.state.profile?.id ?? '');
    const cached = cachedExecutionOriginMachineSnapshots;
    if (
        cached?.profiles === profiles
        && cached.activeServerId === params.activeServerId
        && cached.accountId === accountId
        && cached.isDataReady === params.state.isDataReady
        && cached.machines === params.state.machines
        && cached.machineListByServerId === params.state.machineListByServerId
        && cached.machineListStatusByServerId === params.state.machineListStatusByServerId
    ) return cached.snapshots;

    const snapshots = resolveAllProfileMachineInventorySnapshots({
        profiles,
        activeServerId: params.activeServerId,
        activeInventoryLoaded: params.state.isDataReady,
        activeMachines: params.state.isDataReady ? Object.values(params.state.machines) : [],
        machineListByServerId: params.state.machineListByServerId,
        machineListStatusByServerId: params.state.machineListStatusByServerId,
        accountId,
        loadWarmEntries: loadMachineDisplayWarmCacheEntries,
    });
    cachedExecutionOriginMachineSnapshots = {
        profiles,
        activeServerId: params.activeServerId,
        accountId,
        isDataReady: params.state.isDataReady,
        machines: params.state.machines,
        machineListByServerId: params.state.machineListByServerId,
        machineListStatusByServerId: params.state.machineListStatusByServerId,
        snapshots,
    };
    return snapshots;
}

function usePluginExecutionOriginMachineSnapshots(params: Readonly<{
    enabled: boolean;
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
}>): readonly ServerMachineInventorySnapshotV1[] {
    const activeServerId = useActiveServerSnapshot().serverId;
    const profilesGeneration = useServerProfilesGeneration();
    const settledRef = React.useRef<Readonly<{
        key: string;
        snapshots: readonly ServerMachineInventorySnapshotV1[];
    }> | null>(null);
    const selectSnapshots = React.useCallback((state: StorageState) => {
        if (!params.enabled) return DISABLED_EXECUTION_ORIGIN_MACHINE_SNAPSHOT_SELECTION;
        const snapshots = readExecutionOriginMachineSnapshots({ activeServerId, profilesGeneration, state });
        const key = `${state.profile.id}\u0000${serializePluginMachineExecutionOriginMachineFacts({
            pluginId: params.pluginId,
            materializations: params.materializations,
            sources: params.sources,
            machineSnapshots: snapshots,
        })}`;
        if (settledRef.current?.key === key) return settledRef.current;
        const settled = Object.freeze({ key, snapshots });
        settledRef.current = settled;
        return settled;
    }, [activeServerId, params.enabled, params.materializations, params.pluginId, params.sources, profilesGeneration]);
    return getStorage()(selectSnapshots).snapshots;
}

export function advancePluginExecutionOriginSelectionRevision(
    previous: PluginExecutionOriginSelectionRevisionState,
    pluginId: string,
    origin: PluginMachineExecutionOriginV1 | null,
): PluginExecutionOriginSelectionRevisionState {
    const unchanged = previous.pluginId === pluginId
        && (
            previous.origin === null
                ? origin === null
                : origin !== null && arePluginMachineExecutionOriginsEqual(previous.origin, origin)
        );
    return unchanged
        ? previous
        : Object.freeze({ pluginId, origin, revision: previous.revision + 1 });
}

/** Invocation-time closure over the current Availability and raw machine owners. */
export function resolveFreshPluginMachineExecutionOrigin(params: Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    reader: PluginAccountAvailabilityReader | null;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    sourceCandidates?: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
}>): FreshPluginMachineExecutionOriginV1 | null {
    const admission = params.reader?.readMaterializations();
    const materializationCandidates = admission?.kind === 'available'
        ? admission.materializations.filter((entry) => entry.pluginId === params.pluginId).map((materialization) => {
            const release = params.classifyRelease(materialization);
            const rejected = !materialization.enabled ? 'disabled' as const
                : materialization.trustState !== 'trusted' ? 'untrusted' as const
                    : !resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: materialization.serverIdentityId, machineId: materialization.machineId }) ? 'offline' as const : null;
            return { materialization, ...release, ...(rejected ? { validation: { kind: 'rejected' as const, reason: rejected } } : {}) };
        }) : [];
    const sourceCandidates = (params.sourceCandidates ?? []).map((candidate): PluginMachineSourceExecutionOriginCandidateV1 => {
        const origin = candidate.source.origin;
        const machineTarget = resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: origin.serverIdentityId, machineId: origin.sourceRef.machineId });
        return machineTarget ? candidate : { ...candidate, validation: { kind: 'rejected', reason: 'offline' } };
    });
    const candidates = combinePluginMachineExecutionOriginCandidates(materializationCandidates, sourceCandidates);
    const state = resolvePluginMachineExecutionOriginState({ pluginId: params.pluginId, storedOrigin: params.origin,
        candidates, declaredDefaultOrigins: params.declaredDefaultOrigins });
    if (state.kind !== 'selected') return null;
    const origin = state.origin;
    const machineTarget = resolveFreshMachineAdministrationExecutionTarget({
        serverIdentityId: origin.serverIdentityId,
        machineId: getPluginMachineExecutionOriginRef(origin).machineId,
    });
    if (!machineTarget) return null;
    return Object.freeze({ origin, ...('source' in state.candidate ? { source: state.candidate.source } : { materialization: state.candidate.materialization }), machineTarget });
}

export type PluginMachineExecutionOriginSelectionV1 = Readonly<{
    candidates: readonly PluginExecutionOriginCandidateV1[];
    machineCandidates?: readonly MachineAdministrationCandidateV1[];
    state: PluginMachineExecutionOriginStateV1;
    selectedOrigin: PluginMachineExecutionOriginV1 | null;
    canExecute: boolean;
    selectOrigin: (origin: PluginMachineExecutionOriginV1) => Promise<PluginExecutionOriginSelectionMutationResult>;
    clearOrigin: () => Promise<PluginExecutionOriginSelectionMutationResult>;
    resolveExecutionOrigin: () => FreshPluginMachineExecutionOriginV1 | null;
}>;

export type PluginExecutionOriginSelectionMutationResult =
    | OneShotAccountSettingsMutationResult<void>
    | Readonly<{ status: 'unavailable' }>;

/**
 * Exact plugin-origin selection over the canonical Account Availability
 * reader. Artifact release classification is a required dependency, keeping
 * immutable-content and compatibility authority out of Administration.
 */
export function usePluginMachineExecutionOriginSelection(params: Readonly<{
    pluginId: string;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    enabled?: boolean;
    sourceCandidates?: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    readSourceCandidates?: () => readonly PluginMachineSourceExecutionOriginCandidateV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    readDeclaredDefaultOrigins?: () => readonly PluginMachineExecutionOriginV1[];
    /** Renderless app-shell consumers do not subscribe to machine labels or heartbeat timestamps. */
    includeMachineCandidates?: boolean;
}>): PluginMachineExecutionOriginSelectionV1 {
    const reader = useActivePluginAccountAvailabilityReader();
    const enabled = params.enabled !== false;
    const materializationAdmission = React.useMemo(
        () => enabled ? reader?.readMaterializations() ?? null : null,
        [enabled, reader],
    );
    const includeMachineCandidates = params.includeMachineCandidates !== false;
    const semanticMachineSnapshots = usePluginExecutionOriginMachineSnapshots({
        enabled: enabled && !includeMachineCandidates,
        pluginId: params.pluginId,
        materializations: materializationAdmission?.kind === 'available' ? materializationAdmission.materializations : [],
        sources: params.sourceCandidates ?? [],
    });
    const presentationMachineSnapshots = useAllProfileMachineInventorySnapshots(enabled && includeMachineCandidates);
    const machineSnapshots = includeMachineCandidates ? presentationMachineSnapshots : semanticMachineSnapshots;
    const machineCandidates = React.useMemo(() => enabled && includeMachineCandidates
        ? buildMachineAdministrationCandidatesFromSnapshots({ snapshots: presentationMachineSnapshots })
        : Object.freeze([]), [enabled, includeMachineCandidates, presentationMachineSnapshots]);
    const selections = useSetting('machineAdministrationSelectionsV1');
    const settingsVersion = useSettingsVersion();
    const expectedSettingsScope = useAccountSettingsScope();
    const storedOrigin = selections.pluginExecutionOriginsByPluginId[params.pluginId] ?? null;
    const selectionRevisionRef = React.useRef<PluginExecutionOriginSelectionRevisionState>({
        pluginId: params.pluginId,
        origin: storedOrigin,
        revision: 0,
    });
    selectionRevisionRef.current = advancePluginExecutionOriginSelectionRevision(
        selectionRevisionRef.current,
        params.pluginId,
        storedOrigin,
    );
    const machineFactsKey = serializePluginMachineExecutionOriginMachineFacts({ pluginId: params.pluginId,
        materializations: materializationAdmission?.kind === 'available' ? materializationAdmission.materializations : [],
        sources: params.sourceCandidates ?? [], machineSnapshots });
    // Raw inventory can refresh presentation without changing any selection fact.
    const candidates = React.useMemo(() => enabled ? combinePluginMachineExecutionOriginCandidates(buildPluginMachineExecutionOriginCandidates({
        pluginId: params.pluginId,
        materializations: materializationAdmission?.kind === 'available'
            ? materializationAdmission.materializations
            : [],
        machineSnapshots,
        classifyRelease: params.classifyRelease,
    }), buildPluginMachineSourceExecutionOriginCandidates({ pluginId: params.pluginId,
        sources: params.sourceCandidates ?? [], machineSnapshots })) : Object.freeze([]), [enabled, machineFactsKey, materializationAdmission, params.classifyRelease, params.pluginId, params.sourceCandidates]);
    const state = React.useMemo<PluginMachineExecutionOriginStateV1>(() => enabled ? resolvePluginMachineExecutionOriginState({
        pluginId: params.pluginId,
        storedOrigin,
        candidates,
        declaredDefaultOrigins: params.declaredDefaultOrigins,
    }) : Object.freeze({ kind: 'selectionRequired', candidates }), [enabled, candidates, params.declaredDefaultOrigins, params.pluginId, storedOrigin]);
    const currentParamsRef = React.useRef(params);
    currentParamsRef.current = params;

    const selectOrigin = React.useCallback(async (
        origin: PluginMachineExecutionOriginV1,
    ): Promise<PluginExecutionOriginSelectionMutationResult> => {
        if (!enabled) return { status: 'unavailable' };
        const proposed = resolvePluginMachineExecutionOriginState({
            pluginId: params.pluginId,
            storedOrigin: origin,
            candidates,
        });
        if (proposed.kind !== 'selected' || settingsVersion === null) return { status: 'unavailable' };
        return await persistMachineAdministrationSelectionMutation(expectedSettingsScope, settingsVersion, (current) => (
            setPluginMachineExecutionOriginPreference(current, params.pluginId, proposed.origin)
        ));
    }, [enabled, candidates, expectedSettingsScope, params.pluginId, settingsVersion]);

    const clearOrigin = React.useCallback(async (): Promise<PluginExecutionOriginSelectionMutationResult> => {
        if (!enabled || settingsVersion === null) return { status: 'unavailable' };
        return await persistMachineAdministrationSelectionMutation(expectedSettingsScope, settingsVersion, (current) => (
            clearPluginMachineExecutionOriginPreference(current, params.pluginId)
        ));
    }, [enabled, expectedSettingsScope, params.pluginId, settingsVersion]);

    const resolveExecutionOrigin = React.useCallback(() => {
        if (!enabled || !areAccountSettingsScopesEqual(expectedSettingsScope, storage.getState().settingsScope)) return null;
        const origin = storage.getState().settings.machineAdministrationSelectionsV1
            .pluginExecutionOriginsByPluginId[params.pluginId] ?? null;
        selectionRevisionRef.current = advancePluginExecutionOriginSelectionRevision(
            selectionRevisionRef.current,
            params.pluginId,
            origin,
        );
        const resolved = resolveFreshPluginMachineExecutionOrigin({
            pluginId: params.pluginId,
            origin,
            reader,
            classifyRelease: params.classifyRelease,
            sourceCandidates: currentParamsRef.current.readSourceCandidates?.() ?? currentParamsRef.current.sourceCandidates,
            declaredDefaultOrigins: currentParamsRef.current.readDeclaredDefaultOrigins?.() ?? currentParamsRef.current.declaredDefaultOrigins,
        });
        return resolved === null
            ? null
            : Object.freeze({
                ...resolved,
                selectionRevision: selectionRevisionRef.current.revision,
            });
    }, [enabled, expectedSettingsScope, params.classifyRelease, params.pluginId, reader]);

    const canExecute = React.useMemo(() => enabled && resolveFreshPluginMachineExecutionOrigin({
        pluginId: params.pluginId,
        origin: storedOrigin,
        reader,
        classifyRelease: params.classifyRelease,
        sourceCandidates: params.sourceCandidates,
        declaredDefaultOrigins: params.declaredDefaultOrigins,
    }) !== null, [enabled, machineFactsKey, params.classifyRelease, params.pluginId, params.sourceCandidates,
        params.declaredDefaultOrigins, reader, storedOrigin]);

    return React.useMemo(() => ({
        candidates,
        machineCandidates,
        state,
        selectedOrigin: enabled ? state.kind === 'selected' ? state.origin : storedOrigin : null,
        canExecute,
        selectOrigin,
        clearOrigin,
        resolveExecutionOrigin,
    }), [
        candidates,
        canExecute,
        machineCandidates,
        enabled,
        clearOrigin,
        resolveExecutionOrigin,
        selectOrigin,
        state,
        storedOrigin,
    ]);
}
