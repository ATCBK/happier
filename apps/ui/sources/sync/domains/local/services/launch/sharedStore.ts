import { createSharedSubscriptionStore } from '@/sync/runtime/subscriptions/sharedSubscriptionStore';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import {
    type LocalServiceLauncherSnapshotClientInput,
    type LocalServiceLauncherSnapshotClientResult,
} from './api';
import { fetchLocalServiceLauncherSnapshotViaMachineRpc } from './machineRpc';
import {
    applyLocalServiceLauncherRefreshStarted,
    applyLocalServiceLauncherSnapshot,
    createLocalServiceLauncherState,
    failLocalServiceLauncherRefresh,
    readLocalServiceLauncherSnapshotTime,
} from './store';
import type { LocalServiceLauncherSnapshot, LocalServiceLauncherState } from './types';
import {
    getLocalServiceInventoryState,
    subscribeLocalServiceCredentialRetirement,
    subscribeLocalServiceInventoryStore,
    type LocalServiceInventorySnapshotClient,
} from '../inventory/sharedStore';

export type LocalServiceLauncherSnapshotClient = (
    input: LocalServiceLauncherSnapshotClientInput,
) => Promise<LocalServiceLauncherSnapshotClientResult>;

export type LocalServiceLauncherStoreKeyInput = Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string | null;
    scope?: 'workspace' | 'machine' | null;
    workspaceRoot?: string | null;
    projection?: 'managed_bindings' | null;
    accountId?: string | null;
    credentialKey?: string | null;
}>;

type NormalizedLocalServiceLauncherStoreKeyInput = Readonly<{
    machineId: string;
    serverId: string | null;
    sessionId: string | null;
    scope: 'workspace' | 'machine' | null;
    workspaceRoot: string | null;
    projection: 'managed_bindings' | null;
    accountId: string | null;
    credentialKey: string | null;
}>;

export const EMPTY_LOCAL_SERVICE_LAUNCHER_STATE: LocalServiceLauncherState = createLocalServiceLauncherState();

const defaultSnapshotClient: LocalServiceLauncherSnapshotClient = (input) => (
    fetchLocalServiceLauncherSnapshotViaMachineRpc(input)
);

function normalizeInput(input: LocalServiceLauncherStoreKeyInput): NormalizedLocalServiceLauncherStoreKeyInput {
    return {
        machineId: input.machineId,
        serverId: input.serverId ?? null,
        sessionId: input.sessionId ?? null,
        scope: input.scope ?? null,
        workspaceRoot: input.workspaceRoot ?? null,
        projection: input.projection ?? null,
        accountId: input.accountId ?? null,
        credentialKey: input.credentialKey ?? null,
    };
}

function storeKey(input: LocalServiceLauncherStoreKeyInput): string {
    return JSON.stringify([
        input.serverId ?? '',
        input.machineId,
        input.sessionId ?? '',
        input.scope ?? '',
        input.workspaceRoot ?? '',
        input.projection ?? '',
        input.accountId ?? '',
        input.credentialKey ?? '',
    ]);
}

function entryMatches(
    entryInput: LocalServiceLauncherStoreKeyInput,
    publishInput: LocalServiceLauncherStoreKeyInput,
): boolean {
    const entry = normalizeInput(entryInput);
    return entry.machineId === publishInput.machineId
        && entry.accountId === (publishInput.accountId ?? null)
        && entry.credentialKey === (publishInput.credentialKey ?? null)
        && (publishInput.serverId === undefined || entry.serverId === (publishInput.serverId ?? null))
        && (publishInput.sessionId === undefined || entry.sessionId === (publishInput.sessionId ?? null))
        && (publishInput.scope === undefined || entry.scope === (publishInput.scope ?? null))
        && (publishInput.workspaceRoot === undefined || entry.workspaceRoot === (publishInput.workspaceRoot ?? null));
}

function failRefresh(
    state: LocalServiceLauncherState,
    input: NormalizedLocalServiceLauncherStoreKeyInput,
    reasonCode: string,
): LocalServiceLauncherState {
    return failLocalServiceLauncherRefresh(state, {
        machineId: input.machineId,
        sessionId: input.sessionId ?? undefined,
        reasonCode,
    });
}

const store = createSharedSubscriptionStore<
    LocalServiceLauncherStoreKeyInput,
    LocalServiceLauncherState,
    LocalServiceLauncherSnapshot,
    LocalServiceLauncherSnapshotClient
>({
    // Same credential-owned retention and qualified identity as the inventory freshness owner.
    retainState: true,
    subscribeRetirement: (input, retire) => subscribeLocalServiceCredentialRetirement(input, () => {
        const key = storeKey(normalizeInput(input));
        const subscription = inventorySubscriptions.get(key);
        if (subscription) {
            inventorySubscriptions.delete(key);
            subscription.dispose();
        }
        retire();
    }),
    emptyState: EMPTY_LOCAL_SERVICE_LAUNCHER_STATE,
    createState: createLocalServiceLauncherState,
    normalizeInput,
    storeKey,
    defaultSnapshotClient,
    // A launcher read can fail while inventory remains healthy and unchanged. Its own
    // demand must recover on the same authenticated reconnect, without a scan delta.
    subscribeRecovery: (input, recover) => subscribeMachineRpcRecovery({ ...input, expectedAccountId: input.accountId }, () => {
        // A retired inventory owns recovery until its current snapshot arrives. Its
        // availability publication requests this projection once, after that barrier.
        if (!inventorySubscriptions.get(storeKey(normalizeInput(input)))?.isUnavailable()) recover(true);
    }),
    beginRefresh: (state, input) => {
        if (state.updatedAt !== null) return state;
        const normalized = normalizeInput(input);
        return applyLocalServiceLauncherRefreshStarted(state, {
            machineId: normalized.machineId,
            sessionId: normalized.sessionId ?? undefined,
        });
    },
    refresh: async ({ input, state, snapshotClient, signal }) => {
        const normalized = normalizeInput(input);
        if (getLocalServiceInventoryState(input).refreshState === 'error') {
            // A retired inventory watch cannot prove that an old absence or lifetime is
            // current. Keep the same rows and daemon timestamp, with existing stale UI.
            return (current: LocalServiceLauncherState) => failLocalServiceLauncherRefresh(current, { machineId: normalized.machineId,
                sessionId: normalized.sessionId ?? undefined, reasonCode: 'request_failed', stale: true });
        }
        const receivedAt = readLocalServiceLauncherSnapshotTime(state);
        const result = await snapshotClient({
            machineId: normalized.machineId,
            serverId: normalized.serverId,
            sessionId: normalized.sessionId,
            scope: normalized.scope,
            workspaceRoot: normalized.workspaceRoot,
            ...(normalized.projection ? { projection: normalized.projection } : {}),
            ...(normalized.accountId ? { accountId: normalized.accountId } : {}),
            signal,
        });
        // An Action can publish during the read or after this callback returns.
        // Reconcile once, atomically at the shared owner's commit boundary.
        return (current: LocalServiceLauncherState) => result.ok
            ? applyLocalServiceLauncherSnapshot(current, result.snapshot)
            : readLocalServiceLauncherSnapshotTime(current) !== receivedAt ? current : failRefresh(current, normalized, result.reason);
    },
    failRefresh: (state, input) => (
        failRefresh(state, normalizeInput(input), 'request_failed')
    ),
    applySnapshot: applyLocalServiceLauncherSnapshot,
    matchesPublish: entryMatches,
    // An Action's response only covers the scope it read. Other affected consumers
    // refresh their own projection rather than adopting a machine-wide/other-Session feed.
    snapshotCoversEntry: (entry, _snapshot, published) => storeKey(entry) === storeKey(normalizeInput(published)),
});

// Freshness belongs to the launcher store, including complete managed-binding reads made
// outside a Services page. All projections share the inventory's one parked Machine watch.
const inventorySubscriptions = new Map<string, { input: LocalServiceLauncherStoreKeyInput; count: number; isUnavailable(): boolean; dispose(): void }>();

export function getLocalServiceLauncherState(
    input: LocalServiceLauncherStoreKeyInput,
): LocalServiceLauncherState {
    return store.getState(input);
}

/** Join the subscribed owner's first/current read before consuming its projection. */
export function readLocalServiceLauncherStore(input: LocalServiceLauncherStoreKeyInput): Promise<void> {
    return store.readOnce(input);
}

export function subscribeLocalServiceLauncherStore(
    input: LocalServiceLauncherStoreKeyInput,
    listener: () => void,
    options?: Readonly<{ snapshotClient?: LocalServiceLauncherSnapshotClient; nowMs?: () => number;
        inventorySnapshotClient?: LocalServiceInventorySnapshotClient }>,
): () => void {
    const key = storeKey(normalizeInput(input));
    let subscription = inventorySubscriptions.get(key);
    if (!subscription) {
        const inventoryKey = { machineId: input.machineId, serverId: input.serverId,
            accountId: input.accountId, credentialKey: input.credentialKey };
        let generation = getLocalServiceInventoryState(inventoryKey).generatedAt;
        let unavailable = getLocalServiceInventoryState(inventoryKey).refreshState === 'error';
        const dispose = subscribeLocalServiceInventoryStore(inventoryKey, () => {
            const next = getLocalServiceInventoryState(inventoryKey);
            const availabilityChanged = (next.refreshState === 'error' && !unavailable)
                || (next.refreshState === 'idle' && unavailable);
            if (next.refreshState !== 'refreshing') unavailable = next.refreshState === 'error';
            const generationChanged = next.generatedAt !== generation;
            generation = next.generatedAt;
            // Even the initial scan can finish after a cached launcher response. Keep
            // declaration hydration independent of that scan, then reconcile its result.
            if (availabilityChanged || (generationChanged && next.generatedAt !== null)) store.invalidate(input);
        }, options?.inventorySnapshotClient ? { snapshotClient: options.inventorySnapshotClient } : undefined);
        subscription = { input, count: 0, isUnavailable: () => unavailable, dispose };
        inventorySubscriptions.set(key, subscription);
    }
    subscription.count++;
    const unsubscribe = store.subscribe(input, listener, options);
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        unsubscribe();
        if (--subscription.count === 0) {
            subscription.dispose();
            if (inventorySubscriptions.get(key) === subscription) inventorySubscriptions.delete(key);
        }
    };
}

export function invalidateLocalServiceLauncherStore(input: LocalServiceLauncherStoreKeyInput): void {
    store.invalidate(input);
}

/** External native operations change every subscribed scope/projection on the affected Machine. */
export function invalidateLocalServiceLauncherStores(input: Pick<LocalServiceLauncherStoreKeyInput, 'machineId' | 'serverId' | 'accountId' | 'credentialKey'>): void {
    const scope = { ...input, serverId: input.serverId ?? null };
    for (const subscription of inventorySubscriptions.values()) {
        if (entryMatches(subscription.input, scope)) store.invalidate(subscription.input);
    }
}

/** A successful explicit scan may return the same generation. Recover failed derived
 * reads without making healthy projections re-read unchanged inventory. */
export function recoverLocalServiceLauncherStores(input: Pick<LocalServiceLauncherStoreKeyInput, 'machineId' | 'serverId' | 'accountId' | 'credentialKey'>): void {
    const scope = { ...input, serverId: input.serverId ?? null };
    for (const subscription of inventorySubscriptions.values()) {
        if (entryMatches(subscription.input, scope) && store.getState(subscription.input).refreshStatus === 'error') {
            store.invalidate(subscription.input);
        }
    }
}

export function publishLocalServiceLauncherSnapshot(
    input: LocalServiceLauncherStoreKeyInput,
    snapshot: LocalServiceLauncherSnapshot,
): void {
    store.publish(input, snapshot);
}

export function resetLocalServiceLauncherStoreForTests(): void {
    for (const subscription of inventorySubscriptions.values()) subscription.dispose();
    inventorySubscriptions.clear();
    store.reset();
}
