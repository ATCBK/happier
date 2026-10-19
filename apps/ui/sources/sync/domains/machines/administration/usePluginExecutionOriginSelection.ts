import * as React from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { t } from '@/text';
import { useCurrentUiContextMountedCommand } from '@/components/appShell/currentUiContext/CurrentUiContextCommands';
import type { CurrentUiContextPluginExecutionOriginCommand } from '@/components/appShell/currentUiContext/currentUiContextModel';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { type PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { ActionApprovalRequestCreatedResultSchema, type ActionApprovalRequestCreatedResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { PluginExecutionOriginActionOutputSchemas, type PluginExecutionOriginActionId } from '@happier-dev/protocol/actions/pluginExecutionOriginActionFamily';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useServerProfilesGeneration } from '@/hooks/server/useServerProfilesGeneration';
import { getServerProfileById, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import { loadMachineDisplayWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { readMachineRequestReachabilityRevision, subscribeMachineRequestReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { serverAccountScopeListKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import {
    resolveAllProfileMachineInventorySnapshots,
    type ServerMachineInventorySnapshotV1,
} from '@/sync/domains/machines/machineInventorySnapshots';
import { useActivePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import type { PluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/reader';
import { storage } from '@/sync/domains/state/storageStore';
import {
    type OneShotAccountSettingsMutationResult,
} from '@/sync/engine/settings/syncSettings';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { useActiveServerAccountScope } from '@/sync/store/hooks';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';

import {
    buildPluginMachineExecutionOriginCandidates,
    resolvePluginMachineMaterializationValidation,
    buildPluginMachineSourceExecutionOriginCandidates,
    combinePluginMachineExecutionOriginCandidates,
    resolvePluginMachineExecutionOriginState,
    serializePluginMachineExecutionOriginMachineFacts,
    getPluginExecutionOriginCandidateOrigin,
    getPluginExecutionOriginCandidateVersion,
    isPluginMachineExecutionOriginCandidateSelectable,
    type PluginMachineExecutionOriginStateV1,
    type PluginMachineExecutionOriginRejectionV1,
    type PluginMachineReleaseClassificationV1,
    type PluginMachineSourceExecutionOriginCandidateV1,
    type PluginExecutionOriginCandidateV1,
    type PluginExecutionOriginContextualTarget,
    type PluginExecutionOriginMachineFactReader,
} from './pluginExecutionOrigin';
import { resolveFleetSnapshotMachineRejection } from './fleetUnion';
import { areAccountSettingsScopesEqual, type AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readCurrentPluginMachineExecutionTargetPreference, readPluginMachineExecutionTargetPreference,
    readPluginMachineExecutionLastUsedTarget, rememberPluginMachineExecutionOriginUse } from './selectionPreferences';
import { getSystemTasksRunner } from '@/components/systemTasks/systemTasksRuntime';
import { readLocalDaemonSharedState, subscribeLocalDaemonSharedState } from '@/components/settings/machines/localControl/localDaemonSharedState';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { isDaemonOnActiveRelay } from '@/sync/domains/server/relayDrift/relayDriftModel';
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
    target?: MachineAdministrationTargetV1 | null;
    revision: number;
}>;

const EMPTY_EXECUTION_ORIGIN_MACHINE_SNAPSHOTS: readonly ServerMachineInventorySnapshotV1[] = Object.freeze([]);
const EMPTY_EXECUTION_ORIGIN_MATERIALIZATIONS: readonly PluginMachineMaterializationV1[] = Object.freeze([]);
const EMPTY_EXECUTION_ORIGIN_SOURCES: readonly PluginMachineSourceExecutionOriginCandidateV1[] = Object.freeze([]);
type ExecutionOriginMachineSnapshotSelection = Readonly<{
    key: string;
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    nextRefreshAtMs: number | null;
    readMachineFact: PluginExecutionOriginMachineFactReader;
}>;
const EMPTY_MACHINE_FACT = Object.freeze({ activeAt: 0, rejection: 'unknown' as const, eligible: false });
const DISABLED_EXECUTION_ORIGIN_MACHINE_SNAPSHOT_SELECTION = Object.freeze({
    key: '',
    snapshots: EMPTY_EXECUTION_ORIGIN_MACHINE_SNAPSHOTS,
    nextRefreshAtMs: null,
    readMachineFact: () => EMPTY_MACHINE_FACT,
});

type StorageState = ReturnType<typeof storage.getState>;
type ExecutionOriginMachineFactInputs = Readonly<{
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    readinessServerIdentityId?: string;
}>;
type ExecutionOriginMachineFacts = ExecutionOriginMachineFactInputs & Readonly<{
    selection: ExecutionOriginMachineSnapshotSelection;
    inventoryPending: boolean;
}>;

let cachedServerProfiles: Readonly<{
    generation: number;
    profiles: ReturnType<typeof listServerProfiles>;
}> | null = null;

let cachedExecutionOriginMachineSnapshots: Readonly<{
    profiles: ReturnType<typeof listServerProfiles>;
    activeServerId: string;
    accountScopeKey: string;
    machines: StorageState['machines'];
    machineListByServerId: StorageState['machineListByServerId'];
    machineListStatusByServerId: StorageState['machineListStatusByServerId'];
    observedAtMs: number;
    reachabilityRevision: number;
    nextRefreshAtMs: number | null;
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    machineFactsKey: string;
    factsByPluginId: Map<string, ExecutionOriginMachineFacts>;
    readMachineFact: PluginExecutionOriginMachineFactReader;
    pendingServerIdentityIds: ReadonlySet<string>;
}> | null = null;

function readExecutionOriginMachineFacts(
    producer: NonNullable<typeof cachedExecutionOriginMachineSnapshots>,
    inputs: ExecutionOriginMachineFactInputs,
): ExecutionOriginMachineSnapshotSelection {
    const previous = producer.factsByPluginId.get(inputs.pluginId);
    // Even a plugin with no candidate has a meaningful pending census. Keep
    // that Home's readiness in the semantic key alongside candidate admission.
    const inventoryPending = producer.pendingServerIdentityIds.has(inputs.readinessServerIdentityId ?? '');
    const key = previous?.materializations === inputs.materializations && previous.sources === inputs.sources
        && previous.readinessServerIdentityId === inputs.readinessServerIdentityId && previous.inventoryPending === inventoryPending
        ? previous.selection.key
        : `${producer.accountScopeKey}\u0000${inputs.readinessServerIdentityId ?? ''}\u0000${inventoryPending}\u0000${serializePluginMachineExecutionOriginMachineFacts({
            pluginId: inputs.pluginId, materializations: inputs.materializations, sources: inputs.sources,
            machineSnapshots: producer.snapshots,
            readMachineFact: producer.readMachineFact,
        })}`;
    const selection = previous?.selection.key === key && previous.selection.snapshots === producer.snapshots
        ? previous.selection : Object.freeze({ key, snapshots: producer.snapshots, nextRefreshAtMs: producer.nextRefreshAtMs,
            readMachineFact: producer.readMachineFact });
    producer.factsByPluginId.set(inputs.pluginId, { pluginId: inputs.pluginId,
        materializations: inputs.materializations, sources: inputs.sources,
        readinessServerIdentityId: inputs.readinessServerIdentityId, inventoryPending, selection });
    return selection;
}

/** A Home whose Machine list has not been read yet (a failed or signed-out read is an answer): what it holds is unknown, not empty. */
function isMachineInventoryPending(snapshot: ServerMachineInventorySnapshotV1): boolean {
    if (snapshot.kind !== 'resolved' && snapshot.kind !== 'unknown') return false;
    if (snapshot.kind === 'resolved' && snapshot.settled === true) return (snapshot.executionPendingMachineIds?.length ?? 0) > 0;
    return snapshot.inventoryStatus !== 'error' && snapshot.inventoryStatus !== 'signedOut';
}

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
function readExecutionOriginMachineSnapshots(params: ExecutionOriginMachineFactInputs & Readonly<{
    activeServerId: string;
    profilesGeneration: number;
    reachabilityRevision: number;
    accountScopesByServerId: ReadonlyMap<string, ServerAccountScope>;
    state: StorageState;
}>): ExecutionOriginMachineSnapshotSelection {
    const profiles = readServerProfilesForGeneration(params.profilesGeneration);
    const accountScopeKey = serverAccountScopeListKey([...params.accountScopesByServerId.values()]);
    const facts = { ...params, readinessServerIdentityId: params.readinessServerIdentityId
        ?? readPluginMachineExecutionTargetPreference(params.state.settings.machineAdministrationTargetsLocalV1, params.pluginId)?.serverIdentityId
        ?? getServerProfileById(params.activeServerId)?.serverIdentityId ?? undefined };
    const cached = cachedExecutionOriginMachineSnapshots;
    const nowMs = Date.now();
    if (
        cached?.profiles === profiles
        && cached.activeServerId === params.activeServerId
        && cached.accountScopeKey === accountScopeKey
        && cached.machines === params.state.machines
        && cached.machineListByServerId === params.state.machineListByServerId
        && cached.machineListStatusByServerId === params.state.machineListStatusByServerId
        && cached.reachabilityRevision === params.reachabilityRevision
        && nowMs >= cached.observedAtMs
        && (cached.nextRefreshAtMs === null || nowMs < cached.nextRefreshAtMs)
    ) return readExecutionOriginMachineFacts(cached, facts);

    const snapshots = resolveAllProfileMachineInventorySnapshots({
        profiles,
        activeServerId: params.activeServerId,
        activeMachines: Object.values(params.state.machines),
        machineListByServerId: params.state.machineListByServerId,
        machineListStatusByServerId: params.state.machineListStatusByServerId,
        accountScopesByServerId: params.accountScopesByServerId,
        loadWarmEntries: loadMachineDisplayWarmCacheEntries,
    });
    // Time is also an eligibility input. Reuse the canonical presence deadline
    // rather than keeping equal raw rows authoritative past their grace period.
    let nextRefreshAtMs: number | null = null;
    for (const snapshot of snapshots) for (const machine of snapshot.machines) {
        const deadline = readMachineStatusNextRefreshAtMs(machine, nowMs);
        if (deadline !== null && (nextRefreshAtMs === null || deadline < nextRefreshAtMs)) nextRefreshAtMs = deadline;
    }
    // Project eligibility once at the inventory producer. Heartbeat timestamps
    // and labels can change without changing a plugin's machine-origin facts.
    // Fleet remains the policy owner; this is only its reusable projection.
    const inventoryByHome = new Map<string, Readonly<{
        snapshot: Extract<ServerMachineInventorySnapshotV1, { kind: 'resolved' }>;
        factsByMachineId: ReadonlyMap<string, ReturnType<PluginExecutionOriginMachineFactReader>>;
    }>>();
    const pendingServerIdentityIds = new Set<string>();
    const inventoryFacts = snapshots.flatMap(snapshot => {
        if ('serverIdentityId' in snapshot && isMachineInventoryPending(snapshot)) pendingServerIdentityIds.add(snapshot.serverIdentityId);
        if (snapshot.kind !== 'resolved') return [];
        const eligible = new Set(snapshot.executionEligibleMachineIds);
        const pending = new Set(snapshot.executionPendingMachineIds);
        const factsByMachineId = new Map(snapshot.machines.map(machine => [machine.id, {
            activeAt: machine.activeAt,
            rejection: resolveFleetSnapshotMachineRejection({ snapshot, machine, executionEligible: eligible.has(machine.id) }),
            eligible: eligible.has(machine.id),
        }] as const));
        inventoryByHome.set(snapshot.serverIdentityId, { snapshot, factsByMachineId });
        return [[snapshot.serverIdentityId, snapshot.settled === true,
            [...factsByMachineId].sort(([leftId, left], [rightId, right]) => right.activeAt - left.activeAt || leftId.localeCompare(rightId))
                .map(([machineId, fact]) => [machineId, fact.rejection, fact.eligible, pending.has(machineId)])]];
    });
    const machineFactsKey = JSON.stringify(inventoryFacts);
    const readMachineFact: PluginExecutionOriginMachineFactReader = target => {
        const home = inventoryByHome.get(target.serverIdentityId);
        return home?.factsByMachineId.get(target.machineId) ?? { activeAt: 0, eligible: false,
            rejection: resolveFleetSnapshotMachineRejection({ snapshot: home?.snapshot, machine: undefined }) };
    };
    cachedExecutionOriginMachineSnapshots = {
        profiles,
        activeServerId: params.activeServerId,
        accountScopeKey,
        machines: params.state.machines,
        machineListByServerId: params.state.machineListByServerId,
        machineListStatusByServerId: params.state.machineListStatusByServerId,
        observedAtMs: nowMs,
        reachabilityRevision: params.reachabilityRevision,
        nextRefreshAtMs,
        snapshots,
        machineFactsKey,
        readMachineFact,
        pendingServerIdentityIds,
        // This inventory producer owns reuse across selectors/consumers as
        // well as store updates. Its presence deadline invalidates both facts.
        factsByPluginId: cached?.accountScopeKey === accountScopeKey && cached.machineFactsKey === machineFactsKey
            ? cached.factsByPluginId : new Map(),
    };
    return readExecutionOriginMachineFacts(cachedExecutionOriginMachineSnapshots, facts);
}

function usePluginExecutionOriginMachineSnapshots(params: Readonly<{
    enabled: boolean;
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    readinessServerIdentityId?: string;
}>): ExecutionOriginMachineSnapshotSelection {
    const activeServerId = useActiveServerSnapshot().serverId;
    const activeAccountScope = useActiveServerAccountScope(activeServerId);
    const profilesGeneration = useServerProfilesGeneration();
    const profiles = readServerProfilesForGeneration(profilesGeneration);
    const activeHome = activeAccountScope && getServerProfileById(activeAccountScope.serverId)?.serverIdentityId;
    // Only a supplying or explicitly remembered Home can affect this plugin's
    // execution. Unrelated credential resolutions must not wake every reporter.
    // The active Home already uses Sync's admitted Account below.
    const relevantServerIdentityIds = new Set([
        params.readinessServerIdentityId
            ?? readPluginMachineExecutionTargetPreference(storage.getState().settings.machineAdministrationTargetsLocalV1, params.pluginId)?.serverIdentityId
            ?? getServerProfileById(activeServerId)?.serverIdentityId,
        ...params.materializations.filter(entry => entry.pluginId === params.pluginId).map(entry => entry.serverIdentityId),
        ...params.sources.filter(entry => entry.source.origin.sourceRef.pluginId === params.pluginId).map(entry => entry.source.origin.serverIdentityId),
    ]);
    const bindings = useServerCredentialAccountScopeBindings(params.enabled ? profiles
        .filter(profile => profile.serverIdentityId !== activeHome && relevantServerIdentityIds.has(profile.serverIdentityId))
        .map(profile => profile.serverIdentityId) : []);
    const accountScopesByServerId = React.useMemo(() => {
        const scopes = new Map([...bindings].flatMap(([serverId, binding]) =>
            binding.isCurrent() ? [[serverId, binding.scope] as const] : []));
        // The focused Account is already admitted by Sync, just as invocation
        // uses it. A page remount must not withdraw that authority while its
        // separate credential/picker readers initialize. Other Homes still
        // require their own current credential bindings.
        const activeHome = activeAccountScope && getServerProfileById(activeAccountScope.serverId)?.serverIdentityId;
        if (activeAccountScope && activeHome) scopes.set(activeHome, { serverId: activeHome, accountId: activeAccountScope.accountId });
        return scopes;
    }, [activeAccountScope, bindings, profiles]);
    const snapshots = React.useMemo(() => {
        // React can retain the previous getSnapshot while rendering new inputs.
        // Its settled value belongs to this selector, not a ref shared with its successor.
        let previous: ExecutionOriginMachineSnapshotSelection | null = null;
        let observedState: StorageState | null = null;
        const read = () => {
            if (!params.enabled) return DISABLED_EXECUTION_ORIGIN_MACHINE_SNAPSHOT_SELECTION;
            return readExecutionOriginMachineSnapshots({ ...params, activeServerId, profilesGeneration,
                reachabilityRevision: readMachineRequestReachabilityRevision(), accountScopesByServerId, state: storage.getState() });
        };
        const get = () => {
            const state = storage.getState();
            // React's consistency reads must retain one snapshot until an
            // observed source publishes, even across a wall-clock boundary.
            if (previous && observedState === state) return previous;
            observedState = state;
            const selection = read();
            // A presentation refresh can retain the consumer's prior semantic
            // selection. Serialization itself belongs to the shared producer.
            previous = previous?.key === selection.key ? previous : selection;
            return previous;
        };
        const subscribe = (listener: () => void) => {
            if (!params.enabled) return () => {};
            const token = {};
            const refresh = () => {
                // Re-arm from fresh producer facts even when a heartbeat keeps
                // the consumer's semantic selection unchanged. The shared
                // inventory producer computes this deadline once per input.
                const deadline = read().nextRefreshAtMs;
                if (deadline === null) sessionListRuntimeClock.clearWake(token);
                else sessionListRuntimeClock.requestWake(token, deadline);
                observedState = null;
                listener();
            };
            const stopStore = storage.subscribe(refresh);
            const stopClock = sessionListRuntimeClock.subscribe(refresh);
            const stopReachability = subscribeMachineRequestReachability(refresh);
            refresh();
            return () => { stopStore(); stopClock(); stopReachability(); sessionListRuntimeClock.clearWake(token); };
        };
        return { get, subscribe, read };
    }, [activeServerId, params.enabled, params.materializations, params.pluginId, params.sources, params.readinessServerIdentityId,
        profilesGeneration, accountScopesByServerId]);
    // Clock/store notifications re-read authority, but only an eligibility
    // change commits this consumer. Unrelated relative-time wakes stay local.
    React.useSyncExternalStore(snapshots.subscribe, snapshots.get, snapshots.get);
    // Notifications collapse heartbeat-only changes, but another admission
    // input (such as Availability) can still cause a render. Classify against
    // the producer's current rows, not the retained notification snapshot's
    // now-expired presence timestamps.
    return snapshots.read();
}

export function advancePluginExecutionOriginSelectionRevision(
    previous: PluginExecutionOriginSelectionRevisionState,
    pluginId: string,
    origin: PluginMachineExecutionOriginV1 | null,
    target: MachineAdministrationTargetV1 | null = null,
): PluginExecutionOriginSelectionRevisionState {
    const unchanged = previous.pluginId === pluginId
        && previous.target?.serverIdentityId === target?.serverIdentityId
        && previous.target?.machineId === target?.machineId
        && (
            previous.origin === null
                ? origin === null
                : origin !== null && arePluginMachineExecutionOriginsEqual(previous.origin, origin)
        );
    return unchanged
        ? previous
        : Object.freeze({ pluginId, origin, target, revision: previous.revision + 1 });
}

type FreshPluginExecutionOriginParams = Readonly<{
    pluginId: string;
    origin: PluginMachineExecutionOriginV1 | null;
    storedTarget?: MachineAdministrationTargetV1 | null;
    reader: PluginAccountAvailabilityReader | null;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    sourceCandidates?: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    machineRejections?: readonly PluginMachineExecutionOriginRejectionV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    autoPick?: boolean;
    renderedVersion?: string;
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
}>;

/** Read existing local/desktop facts only; the decision stays in pluginExecutionOrigin. */
export function readPluginExecutionOriginAutomaticHints(pluginId: string, candidates: readonly PluginExecutionOriginCandidateV1[],
    machineSnapshots?: readonly ServerMachineInventorySnapshotV1[]) {
    const scope = getActiveServerAccountScope();
    const profile = scope && getServerProfileById(scope.serverId);
    const local = readLocalDaemonSharedState<LocalDaemonStatusData>(getSystemTasksRunner()).status;
    const localMachineTarget = local?.machineId && profile?.serverIdentityId && local.daemonAccountId === scope?.accountId
        && isDaemonOnActiveRelay({ activeRelayUrl: profile.serverUrl, daemonRelayUrl: local.daemonServerUrl }) === true
        ? { serverIdentityId: profile.serverIdentityId, machineId: local.machineId } : null;
    const machineActivity = machineSnapshots ? machineSnapshots.flatMap(snapshot => snapshot.kind === 'resolved'
        ? snapshot.machines.map(machine => ({ serverIdentityId: snapshot.serverIdentityId, machineId: machine.id, activeAt: machine.activeAt })) : [])
        : candidates.flatMap(candidate => {
            const origin = getPluginExecutionOriginCandidateOrigin(candidate);
            const target = { serverIdentityId: origin.serverIdentityId, machineId: getPluginMachineExecutionOriginRef(origin).machineId };
            const fresh = resolveFreshMachineAdministrationExecutionTarget(target);
            return fresh ? [{ ...target, activeAt: fresh.machine.activeAt }] : [];
        });
    return { lastUsedTarget: readPluginMachineExecutionLastUsedTarget(storage.getState().settings.machineAdministrationTargetsLocalV1, pluginId),
        localMachineTarget, machineActivity };
}

/** Invocation-time candidates over the same Availability and raw machine owners. */
export function readFreshPluginMachineExecutionOriginCandidates(params: FreshPluginExecutionOriginParams): readonly PluginExecutionOriginCandidateV1[] {
    const admission = params.reader?.readMaterializations();
    const materializationCandidates = admission?.kind === 'available'
        ? admission.materializations.filter((entry) => entry.pluginId === params.pluginId).map((materialization) => {
            const release = params.classifyRelease(materialization);
            const machineRejection = !resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: materialization.serverIdentityId, machineId: materialization.machineId })
                ? 'offline' : params.machineRejections?.find(entry => entry.serverIdentityId === materialization.serverIdentityId
                    && entry.machineId === materialization.machineId)?.reason ?? null;
            return { materialization, ...release, validation: resolvePluginMachineMaterializationValidation({ materialization, release, machineRejection }) };
        }) : [];
    const sourceCandidates = (params.sourceCandidates ?? []).filter(candidate => candidate.source.origin.sourceRef.pluginId === params.pluginId)
        .map((candidate): PluginMachineSourceExecutionOriginCandidateV1 => {
        const origin = candidate.source.origin;
        const machineTarget = resolveFreshMachineAdministrationExecutionTarget({ serverIdentityId: origin.serverIdentityId, machineId: origin.sourceRef.machineId });
        return machineTarget ? candidate : { ...candidate, validation: { kind: 'rejected', reason: 'offline' } };
    });
    return combinePluginMachineExecutionOriginCandidates(materializationCandidates, sourceCandidates);
}

/** Invocation-time closure over the current Availability and raw machine owners. */
export function resolveFreshPluginMachineExecutionOrigin(params: FreshPluginExecutionOriginParams): FreshPluginMachineExecutionOriginV1 | null {
    const candidates = readFreshPluginMachineExecutionOriginCandidates(params);
    const state = resolvePluginMachineExecutionOriginState({ pluginId: params.pluginId, storedOrigin: params.origin,
        storedTarget: params.storedTarget, homeServerIdentityId: getServerProfileById(getActiveServerAccountScope()?.serverId ?? '')?.serverIdentityId,
        candidates, declaredDefaultOrigins: params.declaredDefaultOrigins, contextualTarget: params.contextualTarget,
        autoPick: params.autoPick, renderedVersion: params.renderedVersion,
        ...readPluginExecutionOriginAutomaticHints(params.pluginId, candidates) });
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
    /** Explicit device/Home Machine intent survives an unavailable current source. */
    storedTarget?: MachineAdministrationTargetV1 | null;
    /** Account availability has not been read yet: "no Machine" is not yet an answer. */
    loading: boolean;
    canExecute: boolean;
    selectOrigin: (origin: PluginMachineExecutionOriginV1) => Promise<PluginExecutionOriginSelectionMutationResult>;
    clearOrigin: () => Promise<PluginExecutionOriginSelectionMutationResult>;
    /** Currentness inspection uses recordUse:false; invocation records the existing last-use hint. */
    resolveExecutionOrigin: (options?: Readonly<{ recordUse?: boolean }>) => FreshPluginMachineExecutionOriginV1 | null;
}>;

export type PluginExecutionOriginSelectionMutationResult =
    | OneShotAccountSettingsMutationResult<void>
    | Readonly<{ status: 'applied'; value: void }>
    | Readonly<{ status: 'unavailable' }>
    | PluginExecutionOriginPreferenceApproval;

export type PluginExecutionOriginPreferenceApproval = Readonly<{
    status: 'approvalPending';
    scope: AccountSettingsScope;
    input: unknown;
    approval: ActionApprovalRequestCreatedResult & Readonly<{
        actionId: Exclude<PluginExecutionOriginActionId, 'plugins.execution_origin.list'>;
    }>;
}>;

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
    /** Known installations whose canonical runtime describe has not answered yet. */
    establishingTargets?: readonly MachineAdministrationTargetV1[];
    machineRejections?: readonly PluginMachineExecutionOriginRejectionV1[];
    readMachineRejections?: () => readonly PluginMachineExecutionOriginRejectionV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    autoPick?: boolean;
    renderedVersion?: string;
    readDeclaredDefaultOrigins?: () => readonly PluginMachineExecutionOriginV1[];
    /** Renderless app-shell consumers do not subscribe to machine labels or heartbeat timestamps. */
    includeMachineCandidates?: boolean;
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
}>): PluginMachineExecutionOriginSelectionV1 {
    const reader = useActivePluginAccountAvailabilityReader(params.pluginId);
    const enabled = params.enabled !== false;
    const materializationAdmission = React.useMemo(
        () => enabled ? reader?.readMaterializations() ?? null : null,
        [enabled, reader],
    );
    const availabilityNotLoaded = enabled && (reader === null || (materializationAdmission?.kind === 'unavailable'
        && materializationAdmission.code === 'account_availability_not_loaded'));
    const includeMachineCandidates = params.includeMachineCandidates !== false;
    const materializations = materializationAdmission?.kind === 'available'
        ? materializationAdmission.materializations : EMPTY_EXECUTION_ORIGIN_MATERIALIZATIONS;
    const sources = params.sourceCandidates ?? EMPTY_EXECUTION_ORIGIN_SOURCES;
    const semanticMachineSelection = usePluginExecutionOriginMachineSnapshots({
        enabled,
        pluginId: params.pluginId,
        materializations,
        sources,
        readinessServerIdentityId: params.contextualTarget?.serverIdentityId,
    });
    const presentationMachineSnapshots = useAllProfileMachineInventorySnapshots(enabled && includeMachineCandidates);
    // Admission and its memo key must observe the same snapshot. The picker
    // resolves its own credential-bound presentation asynchronously; borrowing
    // that snapshot here can memoize a cold refusal after semantic readiness.
    const machineSnapshots = semanticMachineSelection.snapshots;
    const readMachineFact = semanticMachineSelection.readMachineFact;
    const machineCandidates = React.useMemo(() => enabled && includeMachineCandidates
        ? buildMachineAdministrationCandidatesFromSnapshots({ snapshots: presentationMachineSnapshots })
        : Object.freeze([]), [enabled, includeMachineCandidates, presentationMachineSnapshots]);
    const selectStoredTarget = React.useCallback((state: StorageState) => params.contextualTarget !== undefined ? null
        : readPluginMachineExecutionTargetPreference(state.settings.machineAdministrationTargetsLocalV1, params.pluginId),
    [params.pluginId, params.contextualTarget !== undefined]);
    const storedTarget = useStoreWithEqualityFn(storage, selectStoredTarget,
        (left, right) => left?.serverIdentityId === right?.serverIdentityId && left?.machineId === right?.machineId);
    const expectedSettingsScope = useAccountSettingsScope();
    const expectedAccountLifetime = captureActiveServerAccountScopeLifetime();
    const lastUsedTarget = useStoreWithEqualityFn(storage,
        state => readPluginMachineExecutionLastUsedTarget(state.settings.machineAdministrationTargetsLocalV1, params.pluginId),
        (left, right) => left?.serverIdentityId === right?.serverIdentityId && left?.machineId === right?.machineId);
    const localRunner = getSystemTasksRunner();
    const localStatus = React.useSyncExternalStore(
        React.useCallback(listener => enabled ? subscribeLocalDaemonSharedState(localRunner, listener) : () => {}, [enabled, localRunner]),
        React.useCallback(() => enabled ? readLocalDaemonSharedState<LocalDaemonStatusData>(localRunner).status : null, [enabled, localRunner]),
    );
    const [contextualChoice, setContextualChoice] = React.useState<Readonly<{
        pluginId: string;
        target: PluginExecutionOriginContextualTarget;
        accountLifetime: typeof expectedAccountLifetime;
        origin: PluginMachineExecutionOriginV1;
    }> | null>(null);
    const hasContextualChoice = Boolean(params.contextualTarget && contextualChoice
        && contextualChoice.pluginId === params.pluginId
        && contextualChoice.accountLifetime === expectedAccountLifetime
        && contextualChoice.target.serverIdentityId === params.contextualTarget.serverIdentityId
        && contextualChoice.target.machineId === params.contextualTarget.machineId);
    const contextualChoiceRef = React.useRef(contextualChoice);
    contextualChoiceRef.current = contextualChoice;
    const storedOrigin = params.contextualTarget !== undefined
        ? hasContextualChoice ? contextualChoice!.origin : null
        : null;
    const contextualTarget = hasContextualChoice ? undefined : params.contextualTarget;
    const selectionRevisionRef = React.useRef<PluginExecutionOriginSelectionRevisionState>({
        pluginId: params.pluginId,
        origin: storedOrigin,
        revision: 0,
    });
    selectionRevisionRef.current = advancePluginExecutionOriginSelectionRevision(
        selectionRevisionRef.current,
        params.pluginId,
        storedOrigin,
        storedTarget,
    );
    // Picker presentation can refresh independently of canonical eligibility.
    const machineFactsKey = semanticMachineSelection.key;
    // Raw inventory can refresh presentation without changing any selection fact.
    const candidates = React.useMemo(() => enabled ? combinePluginMachineExecutionOriginCandidates(buildPluginMachineExecutionOriginCandidates({
        pluginId: params.pluginId,
        materializations: materializationAdmission?.kind === 'available'
            ? materializationAdmission.materializations
            : [],
        machineSnapshots,
        readMachineFact,
        classifyRelease: params.classifyRelease,
        machineRejections: params.machineRejections,
    }), buildPluginMachineSourceExecutionOriginCandidates({ pluginId: params.pluginId,
        sources: params.sourceCandidates ?? [], machineSnapshots, readMachineFact })) : Object.freeze([]), [enabled, machineFactsKey, materializationAdmission, params.classifyRelease, params.pluginId, params.sourceCandidates, params.machineRejections]);
    const rememberedTarget = storedTarget ?? (storedOrigin ? { serverIdentityId: storedOrigin.serverIdentityId,
        machineId: getPluginMachineExecutionOriginRef(storedOrigin).machineId } : null);
    const storedOriginMachinePresence = rememberedTarget ? readMachineFact(rememberedTarget).rejection
        ?? params.machineRejections?.find(entry => entry.serverIdentityId === rememberedTarget.serverIdentityId
        && entry.machineId === rememberedTarget.machineId)?.reason ?? null : null;
    const resolvedState = React.useMemo<PluginMachineExecutionOriginStateV1>(() => enabled ? resolvePluginMachineExecutionOriginState({
        pluginId: params.pluginId,
        storedOrigin,
        storedTarget,
        homeServerIdentityId: getServerProfileById(expectedSettingsScope?.serverId ?? '')?.serverIdentityId,
        candidates,
        declaredDefaultOrigins: params.declaredDefaultOrigins,
        contextualTarget,
        storedOriginMachinePresence,
        autoPick: params.autoPick, renderedVersion: params.renderedVersion,
        ...readPluginExecutionOriginAutomaticHints(params.pluginId, candidates, machineSnapshots),
        inventoryPending: machineSnapshots.some(snapshot => 'serverIdentityId' in snapshot
            && snapshot.serverIdentityId === (rememberedTarget?.serverIdentityId
                ?? getServerProfileById(expectedSettingsScope?.serverId ?? '')?.serverIdentityId) && isMachineInventoryPending(snapshot)),
    }) : Object.freeze({ kind: 'selectionRequired', candidates }), [enabled, candidates, contextualTarget, params.declaredDefaultOrigins, params.pluginId, storedOrigin, storedTarget, storedOriginMachinePresence, expectedSettingsScope,
        params.autoPick, params.renderedVersion, lastUsedTarget, localStatus, machineFactsKey]);
    // Recording use can change the ranking hint without changing the chosen
    // occurrence. Preserve the selection consumed by mounted surfaces in that case.
    const retainedState = React.useRef(resolvedState);
    const previousState = retainedState.current;
    const state = previousState.kind === 'selected' && resolvedState.kind === 'selected'
        && previousState.candidate === resolvedState.candidate
        && previousState.selectionSource === resolvedState.selectionSource
        && arePluginMachineExecutionOriginsEqual(previousState.origin, resolvedState.origin) ? previousState : resolvedState;
    retainedState.current = state;
    // An admitted selected row does not wait for unrelated census hydration.
    // Unresolved coverage still stays pending when no target can be selected.
    const readinessServerIdentityId = state.kind === 'selected' ? state.origin.serverIdentityId
        : rememberedTarget?.serverIdentityId
            ?? getServerProfileById(expectedSettingsScope?.serverId ?? '')?.serverIdentityId;
    const inventoryPending = React.useMemo(() => machineSnapshots.some((snapshot) => (
        'serverIdentityId' in snapshot && snapshot.serverIdentityId === readinessServerIdentityId && isMachineInventoryPending(snapshot)
    )), [machineSnapshots, readinessServerIdentityId]);
    const establishingTarget = state.kind === 'selected' ? {
        serverIdentityId: state.origin.serverIdentityId, machineId: getPluginMachineExecutionOriginRef(state.origin).machineId,
    } : contextualTarget !== undefined ? contextualTarget : rememberedTarget;
    const projectionPending = contextualTarget !== null && (state.kind === 'unavailable' || state.kind === 'selected')
        && params.establishingTargets?.some(target => establishingTarget
            ? target.serverIdentityId === establishingTarget.serverIdentityId && target.machineId === establishingTarget.machineId
            : target.serverIdentityId === readinessServerIdentityId) === true;
    const loading = availabilityNotLoaded || (enabled && ((inventoryPending && state.kind !== 'selected') || projectionPending));
    const currentParamsRef = React.useRef(params);
    currentParamsRef.current = params;
    const contextualFacts = React.useRef({ params, enabled, reader, expectedAccountLifetime, expectedSettingsScope });
    contextualFacts.current = { params, enabled, reader, expectedAccountLifetime, expectedSettingsScope };
    const contextualCommand = React.useMemo<CurrentUiContextPluginExecutionOriginCommand | null>(() => {
        const target = params.contextualTarget;
        const account = expectedAccountLifetime;
        if (!target || !account || !enabled) return null;
        const facts = () => {
            const latest = contextualFacts.current;
            if (!latest.enabled || latest.expectedAccountLifetime !== account || !account.isCurrent()
                || latest.params.pluginId !== params.pluginId
                || latest.params.contextualTarget?.serverIdentityId !== target.serverIdentityId
                || latest.params.contextualTarget?.machineId !== target.machineId
                || !areAccountSettingsScopesEqual(latest.expectedSettingsScope, storage.getState().settingsScope)) return null;
            return { pluginId: params.pluginId, origin: null, reader: latest.reader, classifyRelease: latest.params.classifyRelease,
                sourceCandidates: latest.params.readSourceCandidates?.() ?? latest.params.sourceCandidates,
                machineRejections: latest.params.readMachineRejections?.() ?? latest.params.machineRejections,
                declaredDefaultOrigins: latest.params.readDeclaredDefaultOrigins?.() ?? latest.params.declaredDefaultOrigins,
                autoPick: latest.params.autoPick, renderedVersion: latest.params.renderedVersion };
        };
        return {
            kind: 'pluginExecutionOrigin', pluginId: params.pluginId, account, target,
            read: () => {
                const current = facts();
                if (!current) return { status: 'unavailable' };
                const choice = contextualChoiceRef.current;
                const storedOrigin = choice?.accountLifetime === account && choice.pluginId === params.pluginId
                    && choice.target.serverIdentityId === target.serverIdentityId && choice.target.machineId === target.machineId
                    ? choice.origin : null;
                const candidates = readFreshPluginMachineExecutionOriginCandidates(current);
                const selection = resolvePluginMachineExecutionOriginState({ ...current, storedOrigin, candidates,
                    contextualTarget: storedOrigin ? undefined : target });
                return { status: 'available', storedOrigin, selectedOrigin: selection.kind === 'selected' ? selection.origin : null,
                    selectionSource: selection.kind === 'selected' ? selection.selectionSource : storedOrigin ? 'pinned' : null,
                    candidates: candidates.map(candidate => ({ origin: getPluginExecutionOriginCandidateOrigin(candidate),
                        version: getPluginExecutionOriginCandidateVersion(candidate), selectable: isPluginMachineExecutionOriginCandidateSelectable(candidate) })) };
            },
            apply: origin => {
                const current = facts();
                if (!current) return { status: 'unavailable' };
                if (origin) {
                    const admitted = resolveFreshPluginMachineExecutionOrigin({ ...current, origin });
                    if (!admitted || !arePluginMachineExecutionOriginsEqual(admitted.origin, origin)) return { status: 'unavailable' };
                }
                const choice = origin ? { pluginId: params.pluginId, target, accountLifetime: account, origin } : null;
                contextualChoiceRef.current = choice;
                setContextualChoice(choice);
                return { status: 'applied' };
            },
        };
    }, [enabled, expectedAccountLifetime, params.pluginId, params.contextualTarget?.serverIdentityId, params.contextualTarget?.machineId]);
    const readContextualCommandId = useCurrentUiContextMountedCommand(contextualCommand, t('settingsPlugins.executionOriginTitle'));

    const executePreference = React.useCallback(async (
        origin: PluginMachineExecutionOriginV1 | null,
    ): Promise<PluginExecutionOriginSelectionMutationResult> => {
        const isCurrent = () => enabled && expectedAccountLifetime?.isCurrent() === true
            && areAccountSettingsScopesEqual(expectedSettingsScope, expectedAccountLifetime.scope)
            && areAccountSettingsScopesEqual(expectedSettingsScope, storage.getState().settingsScope);
        const contextual = params.contextualTarget !== undefined;
        const commandId = contextual ? readContextualCommandId() : null;
        if (!expectedSettingsScope || !isCurrent() || (contextual && !commandId)) return { status: 'unavailable' };
        const actionId = origin === null ? 'plugins.execution_origin.clear' : 'plugins.execution_origin.set';
        const input = { pluginId: params.pluginId,
            ...(contextual ? { contextualTarget: { commandId } } : {}),
            ...(origin === null ? {} : { origin }) };
        // Resolve the canonical policy/provenance owner only on intent. Idle
        // plugin selectors do not construct Action dependencies or approval subscriptions.
        const { createFrontDoorActionExecute } = await import('@/sync/ops/actions/frontDoorRuntimeActionExecutor');
        if (!isCurrent()) return { status: 'unavailable' };
        const result = await createFrontDoorActionExecute()(actionId, input, {
            surface: 'ui', serverId: expectedSettingsScope.serverId, expectedAccountId: expectedSettingsScope.accountId,
        });
        if (!result.ok || !isCurrent()) return { status: 'unavailable' };
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(result.result);
        if (approval.success && approval.data.actionId === actionId) {
            return { status: 'approvalPending', scope: expectedSettingsScope, input,
                approval: { ...approval.data, actionId } };
        }
        const settled = PluginExecutionOriginActionOutputSchemas[actionId].safeParse(result.result);
        if (!settled.success) return { status: 'unavailable' };
        return settled.data.status === 'applied' ? { ...settled.data, value: undefined } : settled.data;
    }, [enabled, expectedAccountLifetime, expectedSettingsScope, params.contextualTarget, params.pluginId, readContextualCommandId]);

    const selectOrigin = React.useCallback((origin: PluginMachineExecutionOriginV1) => executePreference(origin), [executePreference]);
    const clearOrigin = React.useCallback(() => executePreference(null), [executePreference]);

    const resolveExecutionOrigin = React.useCallback((options?: Readonly<{ recordUse?: boolean }>) => {
        if (!enabled || !areAccountSettingsScopesEqual(expectedSettingsScope, storage.getState().settingsScope)) return null;
        const origin = params.contextualTarget !== undefined ? storedOrigin : null;
        const target = params.contextualTarget !== undefined ? null : readCurrentPluginMachineExecutionTargetPreference(params.pluginId);
        selectionRevisionRef.current = advancePluginExecutionOriginSelectionRevision(
            selectionRevisionRef.current,
            params.pluginId,
            origin,
            target,
        );
        const resolved = resolveFreshPluginMachineExecutionOrigin({
            pluginId: params.pluginId,
            origin,
            storedTarget: target,
            reader,
            classifyRelease: params.classifyRelease,
            sourceCandidates: currentParamsRef.current.readSourceCandidates?.() ?? currentParamsRef.current.sourceCandidates,
            machineRejections: currentParamsRef.current.readMachineRejections?.() ?? currentParamsRef.current.machineRejections,
            declaredDefaultOrigins: currentParamsRef.current.readDeclaredDefaultOrigins?.() ?? currentParamsRef.current.declaredDefaultOrigins,
            autoPick: currentParamsRef.current.autoPick, renderedVersion: currentParamsRef.current.renderedVersion,
            contextualTarget,
        });
        if (resolved && expectedSettingsScope && params.contextualTarget === undefined && options?.recordUse !== false) {
            rememberPluginMachineExecutionOriginUse(params.pluginId, resolved.origin, expectedSettingsScope);
        }
        return resolved === null
            ? null
            : Object.freeze({
                ...resolved,
                selectionRevision: selectionRevisionRef.current.revision,
            });
    }, [enabled, expectedSettingsScope, contextualTarget, params.contextualTarget, params.classifyRelease, params.pluginId, reader, storedOrigin]);

    // The app shell consumes candidates/origin without asking to execute.
    // Reopen fresh release and Machine authority only when a consumer reads
    // execution availability, rather than repeating that work on every render.
    const readCanExecute = React.useMemo(() => {
        // Keep the existing memo's exact inputs and lifetime for repeated reads.
        let canExecute: boolean | undefined;
        return () => canExecute ??= enabled && resolveFreshPluginMachineExecutionOrigin({
            pluginId: params.pluginId,
            origin: storedOrigin,
            storedTarget,
            reader,
            classifyRelease: params.classifyRelease,
            sourceCandidates: params.sourceCandidates,
            machineRejections: params.machineRejections,
            declaredDefaultOrigins: params.declaredDefaultOrigins,
            autoPick: params.autoPick, renderedVersion: params.renderedVersion,
            contextualTarget,
        }) !== null;
    }, [enabled, machineFactsKey, params.classifyRelease, params.pluginId, params.sourceCandidates, params.machineRejections,
        contextualTarget, params.declaredDefaultOrigins, params.autoPick, params.renderedVersion, lastUsedTarget, localStatus, reader, storedOrigin, storedTarget]);

    return React.useMemo(() => ({
        candidates,
        machineCandidates,
        state,
        storedTarget,
        loading,
        selectedOrigin: enabled ? state.kind === 'selected' ? state.origin : state.kind === 'unavailable' ? state.storedOrigin : storedOrigin : null,
        get canExecute() { return readCanExecute(); },
        selectOrigin,
        clearOrigin,
        resolveExecutionOrigin,
    }), [
        candidates,
        readCanExecute,
        machineCandidates,
        enabled,
        clearOrigin,
        resolveExecutionOrigin,
        selectOrigin,
        state,
        storedOrigin,
        storedTarget,
        loading,
    ]);
}
