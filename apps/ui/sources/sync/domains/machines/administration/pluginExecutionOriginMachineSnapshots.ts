import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { getServerProfileById, listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { loadMachineDisplayWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import type { storage } from '@/sync/domains/state/storageStore';
import { serverAccountScopeListKey, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveAllProfileMachineInventorySnapshots, type ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import { resolveFleetSnapshotMachineRejection } from './fleetUnion';
import { readPluginExecutionOriginMachineTargets, serializePluginMachineExecutionOriginMachineFacts,
    type PluginMachineSourceExecutionOriginCandidateV1, type PluginExecutionOriginMachineFactReader,
    type PluginExecutionOriginContextualTarget } from './pluginExecutionOrigin';
import { readPluginMachineExecutionTargetPreference } from './selectionPreferences';

export type ExecutionOriginMachineSnapshotSelection = Readonly<{
    key: string;
    eligibilityKey: string;
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    nextRefreshAtMs: number | null;
    readMachineFact: PluginExecutionOriginMachineFactReader;
}>;
type StorageState = Pick<ReturnType<typeof storage.getState>, 'machines' | 'machineListByServerId' | 'machineListStatusByServerId'> & Readonly<{
    settings: Pick<ReturnType<typeof storage.getState>['settings'], 'machineAdministrationTargetsLocalV1'>;
}>;
type ExecutionOriginMachineFactInputs = Readonly<{
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    readinessServerIdentityId?: string;
}>;
type ExecutionOriginMachineFacts = Pick<ExecutionOriginMachineFactInputs, 'materializations' | 'sources'> & Readonly<{
    selection: ExecutionOriginMachineSnapshotSelection;
    targets: readonly PluginExecutionOriginContextualTarget[];
    facts: ReturnType<typeof serializePluginMachineExecutionOriginMachineFacts>;
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
    const sameInputs = previous?.materializations === inputs.materializations && previous.sources === inputs.sources;
    const projectedTargets = sameInputs ? previous.targets : readPluginExecutionOriginMachineTargets(inputs);
    // Shell and page consumers own separate declaration projections. Retain
    // the inventory producer's target identity when only those declarations
    // change; release/custody admission still observes them at its own owner.
    const targets = previous && previous.targets.length === projectedTargets.length
        && projectedTargets.every((target, index) => target.serverIdentityId === previous.targets[index]!.serverIdentityId
            && target.machineId === previous.targets[index]!.machineId) ? previous.targets : projectedTargets;
    const facts = previous?.targets === targets ? previous.facts : serializePluginMachineExecutionOriginMachineFacts({
            pluginId: inputs.pluginId, materializations: inputs.materializations, sources: inputs.sources,
            machineSnapshots: producer.snapshots,
            readMachineFact: producer.readMachineFact,
        });
    const prefix = `${producer.accountScopeKey}\u0000${inputs.readinessServerIdentityId ?? ''}\u0000${inventoryPending}\u0000`;
    const key = `${prefix}${facts.activityKey}`;
    const eligibilityKey = `${prefix}${facts.eligibilityKey}`;
    const selection = previous?.selection.key === key && previous.selection.snapshots === producer.snapshots
        ? previous.selection : Object.freeze({ key, eligibilityKey, snapshots: producer.snapshots, nextRefreshAtMs: producer.nextRefreshAtMs,
            readMachineFact: producer.readMachineFact });
    producer.factsByPluginId.set(inputs.pluginId, {
        materializations: inputs.materializations, sources: inputs.sources,
        targets, facts, selection });
    return selection;
}

/** A Home whose Machine list has not been read yet (a failed or signed-out read is an answer): what it holds is unknown, not empty. */
export function isMachineInventoryPending(snapshot: ServerMachineInventorySnapshotV1): boolean {
    if (snapshot.kind !== 'resolved' && snapshot.kind !== 'unknown') return false;
    if (snapshot.kind === 'resolved' && snapshot.settled === true) return (snapshot.executionPendingMachineIds?.length ?? 0) > 0;
    return snapshot.inventoryStatus !== 'error' && snapshot.inventoryStatus !== 'signedOut';
}

export function readServerProfilesForGeneration(generation: number): ReturnType<typeof listServerProfiles> {
    if (cachedServerProfiles?.generation === generation) return cachedServerProfiles.profiles;
    const profiles = listServerProfiles();
    cachedServerProfiles = { generation, profiles };
    return profiles;
}

/**
 * All app-shell plugin selectors observe the same raw inventory update. Resolve
 * that canonical projection once per store snapshot instead of once per plugin.
 */
export function readExecutionOriginMachineSnapshots(params: ExecutionOriginMachineFactInputs & Readonly<{
    activeServerId: string;
    profiles: ReturnType<typeof listServerProfiles>;
    reachabilityRevision: number;
    accountScopesByServerId: ReadonlyMap<string, ServerAccountScope>;
    state: StorageState;
}>): ExecutionOriginMachineSnapshotSelection {
    const profiles = params.profiles;
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
            // Match the selector's activity semantics: refused targets cannot
            // reorder an executable choice just because their heartbeats move.
            [...factsByMachineId].sort(([leftId, left], [rightId, right]) =>
                (right.rejection === null ? right.activeAt : 0) - (left.rejection === null ? left.activeAt : 0)
                || leftId.localeCompare(rightId))
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
