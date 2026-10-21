import type { PluginMachineMaterializationV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { arePluginMachineExecutionOriginsEqual, getPluginMachineExecutionOriginRef, type PluginMachineExecutionOriginV1 } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { LocalDaemonStatusData } from '@/components/settings/machines/localControl/useLocalDaemonControl';
import { getServerProfileById, areServerProfileIdentifiersEquivalent, type ServerProfile } from '@/sync/domains/server/serverProfiles';
import { loadMachineDisplayWarmCacheEntries } from '@/sync/domains/state/warmCachePersistence';
import { readRegisteredStorageState, subscribeRegisteredStorageState, subscribeRegisteredStorageMachineUpdates } from '@/sync/domains/state/storageStateReaderBridge';
import type { storage } from '@/sync/domains/state/storageStore';
import { serverAccountScopeListKey, type ServerAccountScope, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { resolveAllProfileMachineInventorySnapshots, type ServerMachineInventorySnapshotV1 } from '@/sync/domains/machines/machineInventorySnapshots';
import { readMachineRequestReachabilityRevision, subscribeMachineRequestReachability } from '@/sync/domains/machines/reachability/machineReachability';
import { sessionListRuntimeClock, type SessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import { resolveFleetSnapshotMachineRejection } from './fleetUnion';
import { readPluginExecutionOriginMachineTargets, serializePluginMachineExecutionOriginMachineFacts,
    buildPluginMachineExecutionOriginCandidates, buildPluginMachineSourceExecutionOriginCandidates,
    combinePluginMachineExecutionOriginCandidates, resolvePluginMachineExecutionOriginState,
    type PluginMachineReleaseClassificationV1, type PluginMachineExecutionOriginRejectionV1,
    type PluginExecutionOriginCandidateV1, type PluginMachineExecutionOriginStateV1,
    type PluginMachineSourceExecutionOriginCandidateV1, type PluginExecutionOriginMachineFactReader,
    type PluginExecutionOriginContextualTarget } from './pluginExecutionOrigin';
import { readPluginMachineExecutionTargetPreference, readPluginMachineExecutionLastUsedTarget } from './selectionPreferences';
import { readPluginExecutionOriginAutomaticHints } from './pluginExecutionOriginAutomaticHints';

export type PluginExecutionOriginDescriptiveInputs = Readonly<{
    availabilityRevision: object | null;
    classifyRelease: (materialization: PluginMachineMaterializationV1) => PluginMachineReleaseClassificationV1;
    homeServerIdentityId?: string | null;
    storedOrigin: PluginMachineExecutionOriginV1 | null;
    contextualTarget?: PluginExecutionOriginContextualTarget | null;
    machineRejections?: readonly PluginMachineExecutionOriginRejectionV1[];
    declaredDefaultOrigins?: readonly PluginMachineExecutionOriginV1[];
    establishingTargets?: readonly MachineAdministrationTargetV1[];
    autoPick?: boolean;
    renderedVersion?: string;
    availabilityNotLoaded?: boolean;
    localStatus?: LocalDaemonStatusData | null;
}>;
export type PluginExecutionOriginDescriptiveSelection = Readonly<{
    candidates: readonly PluginExecutionOriginCandidateV1[];
    state: PluginMachineExecutionOriginStateV1;
    loading: boolean;
}>;

export type ExecutionOriginMachineSnapshotSelection = Readonly<{
    key: string;
    eligibilityKey: string;
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    nextRefreshAtMs: number | null;
    readMachineFact: PluginExecutionOriginMachineFactReader;
    selection: PluginExecutionOriginDescriptiveSelection | null;
}>;
type StorageState = Pick<ReturnType<typeof storage.getState>, 'machines' | 'machineListByServerId' | 'machineListStatusByServerId'> & Readonly<{
    settings: Pick<ReturnType<typeof storage.getState>['settings'], 'machineAdministrationTargetsLocalV1'>;
}>;
export type ExecutionOriginMachineSnapshotInputs = Readonly<{
    pluginId: string;
    materializations: readonly PluginMachineMaterializationV1[];
    sources: readonly PluginMachineSourceExecutionOriginCandidateV1[];
    readinessServerIdentityId?: string;
    activeServerId: string;
    profiles: readonly ServerProfile[];
    profilesGeneration?: number;
    accountScopesByServerId: ReadonlyMap<string, ServerAccountScope>;
    accountLifetime?: ServerAccountScopeLifetime | null;
    bindings?: readonly ServerAccountScopeLifetime[];
    selection?: PluginExecutionOriginDescriptiveInputs;
}>;
const EMPTY_FACT = Object.freeze({ activeAt: 0, rejection: 'unknown' as const, eligible: false });
export const EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION: ExecutionOriginMachineSnapshotSelection = Object.freeze({
    key: '', eligibilityKey: '', snapshots: Object.freeze([]), nextRefreshAtMs: null, readMachineFact: () => EMPTY_FACT, selection: null,
});

/** A failed or signed-out census is an answer; an unread census is not empty. */
export function isMachineInventoryPending(snapshot: ServerMachineInventorySnapshotV1): boolean {
    if (snapshot.kind !== 'resolved' && snapshot.kind !== 'unknown') return false;
    if (snapshot.kind === 'resolved' && snapshot.settled === true) return (snapshot.executionPendingMachineIds?.length ?? 0) > 0;
    return snapshot.inventoryStatus !== 'error' && snapshot.inventoryStatus !== 'signedOut';
}

type InventoryPublication = Readonly<{
    snapshots: readonly ServerMachineInventorySnapshotV1[];
    nextRefreshAtMs: number | null;
    readMachineFact: PluginExecutionOriginMachineFactReader;
    pendingHomes: ReadonlySet<string>;
    state: StorageState;
    reachabilityRevision: number;
    observedAtMs: number;
}>;
type Demand = {
    inputs: ExecutionOriginMachineSnapshotInputs;
    targets: readonly PluginExecutionOriginContextualTarget[];
    context: Context;
    facts: Readonly<{ eligibilityKey: string; activityKey: string }> | null;
    factsInventory: InventoryPublication | null;
    eligibilityFacts: readonly ReturnType<PluginExecutionOriginMachineFactReader>[];
    rankedTargets: readonly PluginExecutionOriginContextualTarget[];
    current: ExecutionOriginMachineSnapshotSelection;
    snapshot: ExecutionOriginMachineSnapshotSelection;
    listener: () => void;
    retirements: Array<Readonly<{ dispose(): void }>>;
    description: Readonly<{
        inputs: ExecutionOriginMachineSnapshotInputs;
        key: string;
        eligibilityKey: string;
        storedTarget: MachineAdministrationTargetV1 | null;
        lastUsedTarget: MachineAdministrationTargetV1 | null;
        value: PluginExecutionOriginDescriptiveSelection;
    }> | null;
};
type Context = {
    key: string;
    inputs: ExecutionOriginMachineSnapshotInputs;
    scopes: ReadonlyMap<string, ServerAccountScope>;
    inventory: InventoryPublication | null;
    demands: Set<Demand>;
};
export type ExecutionOriginMachineSnapshotConnection = Readonly<{
    getSnapshot(): ExecutionOriginMachineSnapshotSelection;
    readCurrent(): ExecutionOriginMachineSnapshotSelection;
    updateInputs(inputs: ExecutionOriginMachineSnapshotInputs): void;
    dispose(): void;
}>;
type PublicationDependencies = Readonly<{
    readState(): StorageState | null;
    subscribeState(listener: () => void): (() => void) | null;
    subscribeMachineUpdates(listener: (serverId: string, machineIds: readonly string[]) => void): (() => void) | null;
    clock: SessionListRuntimeClock;
}>;

function sameTargets(left: readonly PluginExecutionOriginContextualTarget[], right: readonly PluginExecutionOriginContextualTarget[]) {
    return left.length === right.length && left.every((target, index) => target.serverIdentityId === right[index]!.serverIdentityId
        && target.machineId === right[index]!.machineId);
}

function sameTarget(left: MachineAdministrationTargetV1 | null | undefined, right: MachineAdministrationTargetV1 | null | undefined) {
    return left?.serverIdentityId === right?.serverIdentityId && left?.machineId === right?.machineId;
}

function sameCandidateInputs(left: ExecutionOriginMachineSnapshotInputs, right: ExecutionOriginMachineSnapshotInputs) {
    const a = left.selection;
    const b = right.selection;
    return a?.classifyRelease === b?.classifyRelease && a?.availabilityRevision === b?.availabilityRevision
        && left.materializations === right.materializations && (left.sources === right.sources
            || left.sources.length === right.sources.length && left.sources.every((candidate, index) => {
                const other = right.sources[index]!;
                return candidate.source.generation === other.source.generation && candidate.source.serverId === other.source.serverId
                    && candidate.source.version === other.source.version && candidate.source.occurrenceId === other.source.occurrenceId
                    && arePluginMachineExecutionOriginsEqual(candidate.source.origin, other.source.origin)
                    && candidate.releaseContent === other.releaseContent && candidate.validation.kind === other.validation.kind
                    && (candidate.validation.kind !== 'rejected' || other.validation.kind === 'rejected' && candidate.validation.reason === other.validation.reason);
            }))
        && (a?.machineRejections === b?.machineRejections || (a?.machineRejections?.length ?? 0) === (b?.machineRejections?.length ?? 0)
            && (a?.machineRejections ?? []).every((entry, index) => sameTarget(entry, b?.machineRejections?.[index])
                && entry.reason === b?.machineRejections?.[index]?.reason)) && left.pluginId === right.pluginId;
}

function sameSelectionInputs(left: ExecutionOriginMachineSnapshotInputs, right: ExecutionOriginMachineSnapshotInputs) {
    const a = left.selection;
    const b = right.selection;
    return sameCandidateInputs(left, right) && left.accountLifetime === right.accountLifetime && a?.homeServerIdentityId === b?.homeServerIdentityId
        && a?.storedOrigin === b?.storedOrigin && sameTarget(a?.contextualTarget, b?.contextualTarget)
        && (a?.contextualTarget === undefined) === (b?.contextualTarget === undefined)
        && (a?.contextualTarget === null) === (b?.contextualTarget === null)
        && (a?.declaredDefaultOrigins === b?.declaredDefaultOrigins || (a?.declaredDefaultOrigins?.length ?? 0) === (b?.declaredDefaultOrigins?.length ?? 0)
            && (a?.declaredDefaultOrigins ?? []).every((origin, index) => arePluginMachineExecutionOriginsEqual(origin, b!.declaredDefaultOrigins![index]!)))
        && (a?.establishingTargets === b?.establishingTargets || (a?.establishingTargets?.length ?? 0) === (b?.establishingTargets?.length ?? 0)
            && (a?.establishingTargets ?? []).every((target, index) => sameTarget(target, b?.establishingTargets?.[index])))
        && a?.autoPick === b?.autoPick && a?.renderedVersion === b?.renderedVersion
        && a?.availabilityNotLoaded === b?.availabilityNotLoaded && a?.localStatus === b?.localStatus;
}

/** The existing inventory producer publishes on source changes; snapshot reads never derive. */
export function createExecutionOriginMachineSnapshotPublication(dependencies: PublicationDependencies) {
    const contexts = new Map<string, Context>();
    const clockToken = {};
    let stops: Array<() => void> = [];

    function describe(demand: Demand, inventory: InventoryPublication, key: string, eligibilityKey: string) {
        const spec = demand.inputs.selection;
        if (!spec) return null;
        const targets = inventory.state.settings.machineAdministrationTargetsLocalV1;
        const storedTarget = spec.contextualTarget !== undefined ? null : readPluginMachineExecutionTargetPreference(targets, demand.inputs.pluginId);
        const lastUsedTarget = readPluginMachineExecutionLastUsedTarget(targets, demand.inputs.pluginId);
        const matches = (description: NonNullable<Demand['description']>) => description.key === key
            && sameSelectionInputs(description.inputs, demand.inputs) && sameTarget(description.storedTarget, storedTarget)
            && sameTarget(description.lastUsedTarget, lastUsedTarget);
        if (demand.description && matches(demand.description)) return demand.description.value;
        const sibling = [...demand.context.demands].find(other => other !== demand && other.description && matches(other.description));
        if (sibling?.description) { demand.description = sibling.description; return sibling.description.value; }
        const previous = demand.description;
        const candidates = previous && previous.eligibilityKey === eligibilityKey && sameCandidateInputs(previous.inputs, demand.inputs)
            ? previous.value.candidates : combinePluginMachineExecutionOriginCandidates(buildPluginMachineExecutionOriginCandidates({
                pluginId: demand.inputs.pluginId, materializations: demand.inputs.materializations, classifyRelease: spec.classifyRelease,
                machineSnapshots: inventory.snapshots, readMachineFact: inventory.readMachineFact, machineRejections: spec.machineRejections,
            }), buildPluginMachineSourceExecutionOriginCandidates({ pluginId: demand.inputs.pluginId, sources: demand.inputs.sources,
                machineSnapshots: inventory.snapshots, readMachineFact: inventory.readMachineFact }));
        const rememberedTarget = storedTarget ?? (spec.storedOrigin && {
            serverIdentityId: spec.storedOrigin.serverIdentityId,
            machineId: getPluginMachineExecutionOriginRef(spec.storedOrigin).machineId,
        });
        const presence = rememberedTarget ? inventory.readMachineFact(rememberedTarget).rejection
            ?? spec.machineRejections?.find(entry => sameTarget(entry, rememberedTarget))?.reason ?? null : null;
        const resolved = resolvePluginMachineExecutionOriginState({ pluginId: demand.inputs.pluginId,
            storedOrigin: spec.storedOrigin, storedTarget, homeServerIdentityId: spec.homeServerIdentityId, candidates,
            declaredDefaultOrigins: spec.declaredDefaultOrigins, contextualTarget: spec.contextualTarget,
            storedOriginMachinePresence: presence, autoPick: spec.autoPick, renderedVersion: spec.renderedVersion,
            ...readPluginExecutionOriginAutomaticHints(demand.inputs.pluginId, candidates, inventory.snapshots),
            inventoryPending: inventory.pendingHomes.has(rememberedTarget?.serverIdentityId ?? spec.homeServerIdentityId ?? ''),
        });
        const old = previous?.value.state;
        const state = old?.kind === 'selected' && resolved.kind === 'selected' && old.candidate === resolved.candidate
            && old.selectionSource === resolved.selectionSource && arePluginMachineExecutionOriginsEqual(old.origin, resolved.origin) ? old : resolved;
        const readinessHome = state.kind === 'selected' ? state.origin.serverIdentityId
            : rememberedTarget?.serverIdentityId ?? spec.homeServerIdentityId;
        const establishingTarget = state.kind === 'selected' ? { serverIdentityId: state.origin.serverIdentityId,
            machineId: getPluginMachineExecutionOriginRef(state.origin).machineId }
            : spec.contextualTarget !== undefined ? spec.contextualTarget : rememberedTarget;
        const projectionPending = spec.contextualTarget !== null && (state.kind === 'unavailable' || state.kind === 'selected')
            && spec.establishingTargets?.some(target => establishingTarget ? sameTarget(target, establishingTarget)
                : target.serverIdentityId === readinessHome) === true;
        const loading = spec.availabilityNotLoaded === true || ((inventory.pendingHomes.has(readinessHome ?? '') && state.kind !== 'selected') || projectionPending);
        const value = previous?.value.candidates === candidates && previous.value.state === state && previous.value.loading === loading
            ? previous.value : Object.freeze({ candidates, state, loading });
        demand.description = { inputs: demand.inputs, key, eligibilityKey, storedTarget, lastUsedTarget, value };
        return value;
    }

    function armClock() {
        let deadline: number | null = null;
        for (const context of contexts.values()) {
            const next = context.inventory?.nextRefreshAtMs;
            if (next != null && (deadline === null || next < deadline)) deadline = next;
        }
        if (deadline === null) dependencies.clock.clearWake(clockToken);
        else dependencies.clock.requestWake(clockToken, deadline);
    }

    function publishDemand(demand: Demand) {
        const { context, inputs } = demand;
        const inventory = context.inventory;
        if (!inventory || (inputs.accountLifetime && !inputs.accountLifetime.isCurrent())) {
            demand.current = EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION;
        } else {
            if (demand.factsInventory !== inventory) {
                const sibling = [...context.demands].find(other => other !== demand && other.inputs.pluginId === inputs.pluginId
                    && other.factsInventory === inventory && sameTargets(other.targets, demand.targets));
                const rank = (target: PluginExecutionOriginContextualTarget) => {
                    const fact = inventory.readMachineFact(target);
                    return fact.rejection === null ? fact.activeAt : 0;
                };
                const compare = (left: PluginExecutionOriginContextualTarget, right: PluginExecutionOriginContextualTarget) =>
                    rank(right) - rank(left) || left.serverIdentityId.localeCompare(right.serverIdentityId) || left.machineId.localeCompare(right.machineId);
                const eligibilityUnchanged = demand.facts !== null && demand.targets.every((target, index) => {
                    const next = inventory.readMachineFact(target);
                    const previous = demand.eligibilityFacts[index];
                    return previous?.eligible === next.eligible && previous.rejection === next.rejection;
                });
                const orderUnchanged = demand.facts !== null && demand.rankedTargets.every((target, index, targets) =>
                    index === 0 || compare(targets[index - 1]!, target) <= 0);
                if (sibling) {
                    demand.facts = sibling.facts;
                    demand.eligibilityFacts = sibling.eligibilityFacts;
                    demand.rankedTargets = sibling.rankedTargets;
                } else if (!eligibilityUnchanged || !orderUnchanged) {
                    demand.facts = serializePluginMachineExecutionOriginMachineFacts({ ...inputs,
                        targets: demand.targets, machineSnapshots: inventory.snapshots, readMachineFact: inventory.readMachineFact });
                    demand.eligibilityFacts = demand.targets.map(inventory.readMachineFact);
                    demand.rankedTargets = [...demand.targets].sort(compare);
                }
                demand.factsInventory = inventory;
            }
            const readinessHome = inputs.readinessServerIdentityId
                ?? readPluginMachineExecutionTargetPreference(inventory.state.settings.machineAdministrationTargetsLocalV1, inputs.pluginId)?.serverIdentityId
                ?? getServerProfileById(inputs.activeServerId)?.serverIdentityId ?? '';
            const prefix = `${context.key}\u0000${readinessHome}\u0000${inventory.pendingHomes.has(readinessHome)}\u0000`;
            const key = `${prefix}${demand.facts!.activityKey}`;
            const eligibilityKey = `${prefix}${demand.facts!.eligibilityKey}`;
            const selection = describe(demand, inventory, key, eligibilityKey);
            if (demand.current.key !== key || demand.current.snapshots !== inventory.snapshots || demand.current.selection !== selection) {
                const sibling = [...context.demands].find(other => other !== demand && other.current.key === key
                    && other.current.snapshots === inventory.snapshots && other.current.selection === selection);
                demand.current = sibling?.current ?? Object.freeze({ key, eligibilityKey, selection,
                    snapshots: inventory.snapshots, nextRefreshAtMs: inventory.nextRefreshAtMs, readMachineFact: inventory.readMachineFact });
            }
        }
        // Raw presentation can advance without waking a semantic consumer.
        if (demand.snapshot.key !== demand.current.key || demand.snapshot.selection !== demand.current.selection) {
            demand.snapshot = demand.current;
            demand.listener();
        }
    }

    function publishContext(context: Context, force = false) {
        const state = dependencies.readState();
        if (!state) return;
        const nowMs = Date.now();
        const revision = readMachineRequestReachabilityRevision();
        const previous = context.inventory;
        const unchanged = !force && previous && previous.state.machines === state.machines
            && previous.state.machineListByServerId === state.machineListByServerId
            && previous.state.machineListStatusByServerId === state.machineListStatusByServerId
            && previous.reachabilityRevision === revision && nowMs >= previous.observedAtMs
            && (previous.nextRefreshAtMs === null || nowMs < previous.nextRefreshAtMs);
        if (!unchanged) {
            const snapshots = resolveAllProfileMachineInventorySnapshots({ profiles: context.inputs.profiles,
                activeServerId: context.inputs.activeServerId, activeMachines: Object.values(state.machines),
                machineListByServerId: state.machineListByServerId, machineListStatusByServerId: state.machineListStatusByServerId,
                accountScopesByServerId: context.scopes, nowMs, loadWarmEntries: loadMachineDisplayWarmCacheEntries });
            let nextRefreshAtMs: number | null = null;
            const pendingHomes = new Set<string>();
            const homes = new Map<string, Readonly<{ snapshot: Extract<ServerMachineInventorySnapshotV1, { kind: 'resolved' }>;
                facts: ReadonlyMap<string, ReturnType<PluginExecutionOriginMachineFactReader>> }>>();
            for (const snapshot of snapshots) {
                if ('serverIdentityId' in snapshot && isMachineInventoryPending(snapshot)) pendingHomes.add(snapshot.serverIdentityId);
                for (const machine of snapshot.machines) {
                    const deadline = readMachineStatusNextRefreshAtMs(machine, nowMs);
                    if (deadline !== null && (nextRefreshAtMs === null || deadline < nextRefreshAtMs)) nextRefreshAtMs = deadline;
                }
                if (snapshot.kind !== 'resolved') continue;
                const eligible = new Set(snapshot.executionEligibleMachineIds);
                const facts = new Map(snapshot.machines.map(machine => [machine.id, {
                    activeAt: machine.activeAt, eligible: eligible.has(machine.id),
                    rejection: resolveFleetSnapshotMachineRejection({ snapshot, machine, executionEligible: eligible.has(machine.id) }),
                }] as const));
                homes.set(snapshot.serverIdentityId, { snapshot, facts });
            }
            context.inventory = { snapshots, nextRefreshAtMs, pendingHomes, state, observedAtMs: nowMs,
                reachabilityRevision: revision,
                readMachineFact: target => {
                    const home = homes.get(target.serverIdentityId);
                    return home?.facts.get(target.machineId) ?? { activeAt: 0, eligible: false,
                        rejection: resolveFleetSnapshotMachineRejection({ snapshot: home?.snapshot, machine: undefined }) };
                } };
        } else {
            if (previous.state.settings.machineAdministrationTargetsLocalV1 === state.settings.machineAdministrationTargetsLocalV1) return;
            context.inventory = { ...previous, state };
        }
        for (const demand of context.demands) publishDemand(demand);
    }

    function publish() {
        for (const context of contexts.values()) publishContext(context);
        armClock();
    }

    function start() {
        if (stops.length > 0) return;
        stops = [dependencies.subscribeState(publish), subscribeMachineRequestReachability(publish),
            dependencies.clock.subscribe(publish), dependencies.subscribeMachineUpdates((serverId, machineIds) => {
                const state = dependencies.readState();
                if (!state) return;
                for (const context of contexts.values()) {
                    const snapshot = context.inventory?.snapshots.find(entry => areServerProfileIdentifiersEquivalent(entry.profileId, serverId));
                    const rows = state.machineListByServerId[serverId]
                        ?? (areServerProfileIdentifiersEquivalent(context.inputs.activeServerId, serverId) ? Object.values(state.machines) : []);
                    // Changed-root updates already published. This receipt adds the
                    // heartbeat-only path that deliberately preserves the store root.
                    if (machineIds.some(id => rows?.find(row => row.id === id)?.activeAt
                        !== snapshot?.machines.find(row => row.id === id)?.activeAt)) publishContext(context, true);
                }
                armClock();
            })].filter((stop): stop is () => void => stop !== null);
    }

    return {
        connect(inputs: ExecutionOriginMachineSnapshotInputs, listener: () => void): ExecutionOriginMachineSnapshotConnection {
            let disposed = false;
            let demand: Demand;
            function bind(next: ExecutionOriginMachineSnapshotInputs) {
                if (disposed) return;
                for (const retirement of demand?.retirements ?? []) retirement.dispose();
                const scopes = new Map([...next.accountScopesByServerId].filter(([serverId, scope]) => {
                    const binding = next.bindings?.find(entry => entry.scope.accountId === scope.accountId
                        && areServerProfileIdentifiersEquivalent(entry.scope.serverId, serverId));
                    return !binding || binding.isCurrent();
                }));
                const key = `${next.activeServerId}\u0000${serverAccountScopeListKey([...scopes.values()].sort((a, b) => a.serverId.localeCompare(b.serverId)))}`;
                let context = contexts.get(key);
                if (!context) {
                    context = { key, inputs: next, scopes, inventory: null, demands: new Set() };
                    contexts.set(key, context);
                } else if ((next.profilesGeneration !== undefined && (context.inputs.profilesGeneration === undefined
                    || next.profilesGeneration > context.inputs.profilesGeneration))
                    || (next.profilesGeneration === undefined && context.inputs.profiles !== next.profiles)) {
                    context.inputs = next;
                    context.inventory = null;
                }
                const previous = demand;
                const targets = previous && previous.inputs.materializations === next.materializations && previous.inputs.sources === next.sources
                    && previous.inputs.pluginId === next.pluginId ? previous.targets : readPluginExecutionOriginMachineTargets(next);
                if (previous) {
                    previous.context.demands.delete(previous);
                    if (previous.context !== context && previous.context.demands.size === 0) contexts.delete(previous.context.key);
                }
                const reuse = previous?.context === context && sameTargets(previous.targets, targets);
                demand = { inputs: next, targets: reuse ? previous.targets : targets, context,
                    facts: reuse ? previous.facts : null, factsInventory: reuse ? previous.factsInventory : null,
                    eligibilityFacts: reuse ? previous.eligibilityFacts : [], rankedTargets: reuse ? previous.rankedTargets : [],
                    current: previous?.current ?? EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION,
                    snapshot: previous?.snapshot ?? EMPTY_EXECUTION_ORIGIN_MACHINE_SELECTION, listener, retirements: [],
                    description: previous?.description ?? null };
                context.demands.add(demand);
                publishContext(context);
                publishDemand(demand);
                for (const lifetime of [next.accountLifetime, ...next.bindings ?? []]) {
                    if (lifetime?.isCurrent()) demand.retirements.push(lifetime.onRetire(() => {
                        if (!disposed) bind(demand.inputs);
                    }));
                }
                armClock();
            }
            start();
            bind(inputs);
            return {
                getSnapshot: () => demand.snapshot,
                readCurrent: () => demand.current,
                updateInputs: bind,
                dispose() {
                    if (disposed) return;
                    disposed = true;
                    for (const retirement of demand.retirements) retirement.dispose();
                    demand.context.demands.delete(demand);
                    if (demand.context.demands.size === 0) contexts.delete(demand.context.key);
                    if (contexts.size === 0) {
                        for (const stop of stops) stop();
                        stops = [];
                    }
                    armClock();
                },
            };
        },
    };
}

export const executionOriginMachineSnapshotPublication = createExecutionOriginMachineSnapshotPublication({
    readState: readRegisteredStorageState,
    subscribeState: subscribeRegisteredStorageState,
    subscribeMachineUpdates: subscribeRegisteredStorageMachineUpdates,
    clock: sessionListRuntimeClock,
});
