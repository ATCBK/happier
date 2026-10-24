import { buildMachineAgentInventoryKey, type MachineAgentInventoryDescriptor, type MachineAgentInventoryItem, type MachineAgentInventoryUnavailable } from '@happier-dev/protocol/capabilities';
import type { MachineAgent, MachineAgentConnectedService } from './machineAgentTypes';
import { projectMachineAgent, reconcileMachineAgents, type MachineAgentCredentialSelection } from './machineAgentModel';
import type { MachinePublishedMetadataV1 } from '@happier-dev/protocol/machines/machinePublishedContentV1';
import { readInstalledMachineAgentInventory } from '@/sync/domains/capabilities/reach/installedMachineAgents';

export type MachineAgentsSnapshot = Readonly<{
    status: 'idle' | 'loading' | 'ready' | 'offline' | 'error';
    agents: readonly MachineAgent[];
    lastCheckedAt: number | null;
}>;
export type MachineAgentInventoryObservation = Readonly<{
    status: MachineAgentsSnapshot['status'];
    items: readonly MachineAgentInventoryItem[];
    unavailable?: readonly MachineAgentInventoryUnavailable[];
    lastCheckedAt: number | null;
    descriptors?: readonly MachineAgentInventoryDescriptor[];
    connectedServicesByAgentId?: Readonly<Record<string, readonly MachineAgentConnectedService[]>>;
    credentialSelectionsByAgentId?: Readonly<Record<string, MachineAgentCredentialSelection>>;
    jobsByAgentId?: Readonly<Record<string, MachineAgent['job']>>;
    dependencyTitlesByKey?: Readonly<Record<string, string>>;
}>;

export const EMPTY_MACHINE_AGENTS: MachineAgentsSnapshot = Object.freeze({ status: 'idle', agents: Object.freeze([]), lastCheckedAt: null });

export type HeldMachineAgentSummary = Readonly<{
    machineCount: number;
    versions: readonly string[];
    unknownVersionCount: number;
    complete: boolean;
}>;

export function createMachineAgentInventoryStore() {
    const snapshots = new Map<string, MachineAgentsSnapshot>();
    const listeners = new Map<string, Set<() => void>>();
    const agentListeners = new Map<string, Set<() => void>>();
    const factsByScope = new Map<string, Map<string, MachineAgentInventoryItem>>();
    const jobsByScope = new Map<string, Readonly<Record<string, MachineAgent['job']>>>();
    const credentialsByScope = new Map<string, NonNullable<MachineAgentInventoryObservation['credentialSelectionsByAgentId']>>();
    return {
        read(key: string): MachineAgentsSnapshot { return snapshots.get(key) ?? EMPTY_MACHINE_AGENTS; },
        /** A mounted summary observes only held installation/version facts; it never acquires inventory. */
        createHeldAgentSummary(keys: readonly string[], agentId: string, definitionId?: string,
            publishedByKey?: ReadonlyMap<string, MachinePublishedMetadataV1['agentInventory']>) {
            const inventoryKeys = [...new Set(keys)];
            type Fact = Readonly<{ installed: boolean; version: string | null; complete: boolean }>;
            const facts = new Map<string, Fact>();
            const versions = new Map<string, number>();
            let machineCount = 0;
            let unknownVersionCount = 0;
            let unknownMachineCount = 0;
            let snapshot: HeldMachineAgentSummary = { machineCount: 0, versions: [], unknownVersionCount: 0, complete: false };
            const listeners = new Set<() => void>();
            let disposers: Array<() => void> = [];
            const adjust = (fact: Fact | undefined, delta: number) => {
                if (fact === undefined) return;
                if (!fact.complete) unknownMachineCount += delta;
                if (!fact.installed) return;
                const version = fact.version;
                machineCount += delta;
                if (version === null) unknownVersionCount += delta;
                else {
                    const count = (versions.get(version) ?? 0) + delta;
                    if (count === 0) versions.delete(version);
                    else versions.set(version, count);
                }
            };
            const update = (key: string) => {
                const cached = this.read(key);
                const inventory = readInstalledMachineAgentInventory(publishedByKey?.get(key), cached, definitionId ? [definitionId] : undefined);
                const agent = cached.agents.find(row => row.agentId === agentId && row.definitionId === definitionId);
                const installed = inventory.agentIds.includes(agentId) && (definitionId === undefined || agent?.installed === true);
                const fact = { installed, version: installed && agent?.installed ? agent.version : null, complete: inventory.complete };
                const previous = facts.get(key);
                if (previous?.installed === fact.installed && previous.version === fact.version && previous.complete === fact.complete) return false;
                adjust(previous, -1);
                facts.set(key, fact);
                adjust(fact, 1);
                return true;
            };
            const publish = () => {
                const nextVersions = [...versions.keys()].sort();
                const complete = inventoryKeys.length > 0 && unknownMachineCount === 0;
                if (snapshot.machineCount === machineCount && snapshot.unknownVersionCount === unknownVersionCount
                    && snapshot.complete === complete
                    && snapshot.versions.length === nextVersions.length && snapshot.versions.every((v, i) => v === nextVersions[i])) return;
                snapshot = { machineCount, versions: nextVersions, unknownVersionCount, complete };
                for (const listener of listeners) listener();
            };
            const refresh = () => { for (const key of inventoryKeys) update(key); publish(); };
            refresh();
            return {
                getSnapshot: () => { if (listeners.size === 0) refresh(); return snapshot; },
                subscribe: (listener: () => void) => {
                    if (listeners.size === 0) {
                        disposers = inventoryKeys.map(key => this.subscribe(key, () => {
                            if (update(key)) publish();
                        }));
                        refresh();
                    }
                    listeners.add(listener);
                    return () => {
                        listeners.delete(listener);
                        if (listeners.size === 0) { for (const off of disposers) off(); disposers = []; }
                    };
                },
            };
        },
        subscribe(key: string, listener: () => void) {
            const subscribers = listeners.get(key) ?? new Set();
            subscribers.add(listener); listeners.set(key, subscribers);
            return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(key); };
        },
        subscribeAgent(key: string, agentId: string, listener: () => void, definitionId?: string) {
            const agentKey = JSON.stringify([key, buildMachineAgentInventoryKey({ agentId, definitionId })]);
            const subscribers = agentListeners.get(agentKey) ?? new Set();
            subscribers.add(listener); agentListeners.set(agentKey, subscribers);
            return () => { subscribers.delete(listener); if (!subscribers.size) agentListeners.delete(agentKey); };
        },
        publish(key: string, observation: MachineAgentInventoryObservation): void {
            const previous = snapshots.get(key) ?? EMPTY_MACHINE_AGENTS;
            if (observation.jobsByAgentId) jobsByScope.set(key, observation.jobsByAgentId);
            const jobs = jobsByScope.get(key);
            if (observation.credentialSelectionsByAgentId) credentialsByScope.set(key, observation.credentialSelectionsByAgentId);
            const credentials = credentialsByScope.get(key);
            const factsById = factsByScope.get(key) ?? new Map<string, MachineAgentInventoryItem>();
            for (const item of observation.items) factsById.set(buildMachineAgentInventoryKey(item), item);
            factsByScope.set(key, factsById);
            const descriptors = observation.descriptors ?? (observation.items.length > 0 ? observation.items : previous.agents);
            const unavailableById = new Map(observation.unavailable?.map(({ agentId, definitionId, ...reason }) => [buildMachineAgentInventoryKey({ agentId, definitionId }), reason]));
            const refreshedIds = new Set(observation.items.map(buildMachineAgentInventoryKey));
            const previousById = new Map(previous.agents.map(agent => [buildMachineAgentInventoryKey(agent), agent]));
            const agents = reconcileMachineAgents(previous.agents, descriptors.map((descriptor) => projectMachineAgent({
                ...descriptor,
                facts: factsById.get(buildMachineAgentInventoryKey(descriptor)) ?? null,
                checking: observation.status === 'loading',
                stale: observation.status === 'offline' || observation.status === 'error',
                staleReason: observation.status === 'offline' ? 'offline' : observation.status === 'error' ? 'error' : undefined,
                unavailableReason: unavailableById.get(buildMachineAgentInventoryKey(descriptor))
                    ?? (refreshedIds.has(buildMachineAgentInventoryKey(descriptor)) ? undefined : previousById.get(buildMachineAgentInventoryKey(descriptor))?.unavailableReason),
                connectedServices: observation.connectedServicesByAgentId?.[descriptor.agentId] ?? previousById.get(buildMachineAgentInventoryKey(descriptor))?.signIn.connectedServices ?? [],
                credentialSelection: credentials?.[descriptor.agentId] ?? { credentialBindings: null },
                job: jobs ? jobs[buildMachineAgentInventoryKey(descriptor)] ?? null : previousById.get(buildMachineAgentInventoryKey(descriptor))?.job ?? null,
                dependencyTitlesByKey: observation.dependencyTitlesByKey,
            })));
            const lastCheckedAt = observation.lastCheckedAt ?? previous.lastCheckedAt;
            if (agents === previous.agents && observation.status === previous.status && lastCheckedAt === previous.lastCheckedAt) return;
            snapshots.set(key, { status: observation.status, agents, lastCheckedAt });
            for (const listener of listeners.get(key) ?? []) listener();
            const prior = new Map(previous.agents.map((agent) => [buildMachineAgentInventoryKey(agent), agent]));
            const next = new Map(agents.map((agent) => [buildMachineAgentInventoryKey(agent), agent]));
            for (const agentId of new Set([...prior.keys(), ...next.keys()])) {
                if (prior.get(agentId) === next.get(agentId)) continue;
                for (const listener of agentListeners.get(JSON.stringify([key, agentId])) ?? []) listener();
            }
        },
        publishJobs(key: string, jobs: ReadonlyMap<string, NonNullable<MachineAgent['job']>>): void {
            const previous = snapshots.get(key) ?? EMPTY_MACHINE_AGENTS;
            this.publish(key, { status: previous.status, items: [], lastCheckedAt: previous.lastCheckedAt, jobsByAgentId: Object.fromEntries(jobs),
                dependencyTitlesByKey: Object.fromEntries(previous.agents.flatMap((agent) => agent.dependencies.map((dependency) => [dependency.key, dependency.title]))),
            });
        },
    };
}

export const machineAgentInventoryStore = createMachineAgentInventoryStore();
