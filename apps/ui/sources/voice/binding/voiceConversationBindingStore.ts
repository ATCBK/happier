import { createStore } from 'zustand/vanilla';

import type { SessionServerLookupStateLike } from '@/sync/domains/session/listing/sessionListLookupState';
import { readRegisteredStorageState, subscribeRegisteredStorageState } from '@/sync/domains/state/storageStateReaderBridge';

import { readPreferredVoiceConversationBindingMetadata } from './voiceConversationBindingMetadata';
import type { VoiceSessionBinding } from './voiceConversationBindingTypes';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import { getActiveServerSnapshot, subscribeActiveServer } from '@/sync/domains/server/serverRuntime';
import { getServerProfilesGeneration, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';
import { areSessionAddressesEqual, normalizeSessionAddress } from '@/sync/domains/session/sessionAddress';

type BindingsByConversationSessionId = Record<string, VoiceSessionBinding>;

/**
 * Memory-only ownership for a direct-media runtime binding. It is deliberately
 * a private symbol rather than a timestamp or persisted field: a later
 * generation can reuse every visible binding field (including `updatedAt`) and
 * still must not be unbound by the retiring attempt.
 */
const runtimeAttemptBindingOwner = Symbol('voiceRuntimeAttemptBindingOwner');
type RuntimeAttemptOwnedBinding = VoiceSessionBinding & Readonly<{
    [runtimeAttemptBindingOwner]?: object;
}>;

function readRuntimeAttemptBindingOwner(binding: VoiceSessionBinding): object | null {
    return (binding as RuntimeAttemptOwnedBinding)[runtimeAttemptBindingOwner] ?? null;
}

/** Normalization copies bindings; equality retains the incumbent attempt's ownership. */
export function areVoiceSessionBindingsEqual(
    left: VoiceSessionBinding | null | undefined,
    right: VoiceSessionBinding | null | undefined,
): boolean {
    if (!left || !right) return false;
    return readRuntimeAttemptBindingOwner(left) === readRuntimeAttemptBindingOwner(right)
        && left.adapterId === right.adapterId
        && left.controlSessionId === right.controlSessionId
        && left.conversationSessionId === right.conversationSessionId
        && areSessionAddressesEqual(left.conversationSessionAddress, right.conversationSessionAddress)
        && (left.targetSessionAddress === null && right.targetSessionAddress === null
            || areSessionAddressesEqual(left.targetSessionAddress, right.targetSessionAddress))
        && left.transcriptMode === right.transcriptMode
        && left.lifetime === right.lifetime
        && left.updatedAt === right.updatedAt;
}

function withRuntimeAttemptBindingOwner(
    binding: VoiceSessionBinding,
    owner: object,
): VoiceSessionBinding {
    const owned = { ...binding } as RuntimeAttemptOwnedBinding;
    // Enumerable symbols survive the store's object-copy normalization while
    // remaining absent from JSON and metadata serialization.
    Object.defineProperty(owned, runtimeAttemptBindingOwner, {
        configurable: false,
        enumerable: true,
        value: owner,
        writable: false,
    });
    return owned;
}

type VoiceSessionBindingStoreState = Readonly<{
    bindingsByConversationSessionId: BindingsByConversationSessionId;
    runtimeBindingsByConversationSessionId: BindingsByConversationSessionId;
    persistedBindingsByConversationSessionId: BindingsByConversationSessionId;
    bind: (binding: VoiceSessionBinding) => void;
    unbind: (conversationSessionId: string) => void;
    replacePersistedBindings: (bindings: ReadonlyArray<VoiceSessionBinding>) => void;
    getByConversationSessionId: (conversationSessionId: string) => VoiceSessionBinding | null;
    getByControlSessionId: (controlSessionId: string) => VoiceSessionBinding | null;
    list: () => ReadonlyArray<VoiceSessionBinding>;
    readPersistedBindings: (state: SessionServerLookupStateLike) => ReadonlyArray<VoiceSessionBinding>;
}>;

function normalizeId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function normalizeBinding(binding: VoiceSessionBinding): VoiceSessionBinding | null {
    const adapterId = normalizeId(binding.adapterId);
    const controlSessionId = normalizeId(binding.controlSessionId);
    const conversationSessionId = normalizeId(binding.conversationSessionId);
    const conversationSessionAddress = normalizeSessionAddress(
        binding.conversationSessionAddress?.serverId,
        binding.conversationSessionAddress?.sessionId,
    );
    const transcriptMode = binding.transcriptMode === 'native_session' || binding.transcriptMode === 'synthetic'
        ? binding.transcriptMode
        : null;
    if (
        !adapterId
        || !controlSessionId
        || !conversationSessionId
        || !conversationSessionAddress
        || conversationSessionAddress.sessionId !== conversationSessionId
        || !transcriptMode
    ) return null;

    const normalized: VoiceSessionBinding = {
        adapterId,
        controlSessionId,
        conversationSessionId,
        conversationSessionAddress,
        ...(binding.lifetime === 'runtime_attempt' ? { lifetime: 'runtime_attempt' as const } : {}),
        transcriptMode,
        targetSessionAddress: binding.targetSessionAddress
            ? normalizeSessionAddress(
                binding.targetSessionAddress.serverId,
                binding.targetSessionAddress.sessionId,
            )
            : null,
        updatedAt: Number.isFinite(binding.updatedAt) ? Number(binding.updatedAt) : 0,
    };
    const owner = readRuntimeAttemptBindingOwner(binding);
    return owner ? withRuntimeAttemptBindingOwner(normalized, owner) : normalized;
}

function upsertBindingRecord(
    currentBindings: BindingsByConversationSessionId,
    binding: VoiceSessionBinding,
): BindingsByConversationSessionId {
    return {
        ...Object.fromEntries(
            Object.entries(currentBindings).filter(
                ([conversationSessionId, existing]) =>
                    existing.controlSessionId !== binding.controlSessionId
                    || conversationSessionId === binding.conversationSessionId,
            ),
        ),
        [binding.conversationSessionId]: binding,
    };
}

function buildBindingsByConversationSessionId(
    bindings: ReadonlyArray<VoiceSessionBinding>,
): BindingsByConversationSessionId {
    let nextBindings: BindingsByConversationSessionId = {};
    for (const binding of bindings) {
        const normalized = normalizeBinding(binding);
        if (!normalized) continue;
        nextBindings = upsertBindingRecord(nextBindings, normalized);
    }
    return nextBindings;
}

function reconcileBindings(
    current: BindingsByConversationSessionId,
    next: BindingsByConversationSessionId,
): BindingsByConversationSessionId {
    let unchanged = Object.keys(current).length === Object.keys(next).length;
    for (const [id, binding] of Object.entries(next)) {
        if (areVoiceSessionBindingsEqual(current[id], binding)) {
            next[id] = current[id]!;
        } else {
            unchanged = false;
        }
    }
    return unchanged ? current : next;
}

/**
 * Canonical "which binding wins" comparator. Newest `updatedAt` wins; on an
 * equal-`updatedAt` tie the larger `conversationSessionId` wins. This is the
 * single tie-break used by both the store merge and the resolver so the two read
 * paths cannot diverge (see audit F1/F7).
 */
export function pickNewerVoiceBinding(
    current: VoiceSessionBinding | null,
    candidate: VoiceSessionBinding | null,
): VoiceSessionBinding | null {
    if (!candidate) return current;
    if (!current) return candidate;
    if (candidate.updatedAt !== current.updatedAt) {
        return candidate.updatedAt > current.updatedAt ? candidate : current;
    }
    if (candidate.conversationSessionId !== current.conversationSessionId) {
        return candidate.conversationSessionId > current.conversationSessionId ? candidate : current;
    }
    return candidate;
}

export function mergeVoiceConversationBindings(
    runtimeBindingsByConversationSessionId: BindingsByConversationSessionId,
    persistedBindingsByConversationSessionId: BindingsByConversationSessionId,
): BindingsByConversationSessionId {
    // Sync describes where another client last bound its control slot. It cannot
    // replace a binding admitted by this client, regardless of wall-clock freshness.
    // The persisted layer still owns discovery before local admission and after cleanup.
    return buildBindingsByConversationSessionId([
        ...Object.values(persistedBindingsByConversationSessionId).sort((left, right) =>
            left.updatedAt - right.updatedAt || left.conversationSessionId.localeCompare(right.conversationSessionId)),
        ...Object.values(runtimeBindingsByConversationSessionId),
    ]);
}

function listPersistedBindingsFromState(state: SessionServerLookupStateLike): ReadonlyArray<VoiceSessionBinding> {
    const bindings: VoiceSessionBinding[] = [];
    if (!state || typeof state !== 'object') {
        return bindings;
    }
    for (const [sessionId, session] of Object.entries(state.sessions ?? {})) {
        if (!session) continue;
        const sourceServerId = normalizeId(session.serverId) ?? normalizeId(getActiveServerSnapshot().serverId);
        const address = normalizeSessionAddress(sourceServerId, sessionId);
        if (!address) continue;
        const ownerMetadata = readVoiceSessionOwnerMetadataFromState(state, address);
        const binding = readPreferredVoiceConversationBindingMetadata({
            conversationSessionId: sessionId,
            preferredMetadata: ownerMetadata,
            directMetadata: null,
            sourceServerId: address.serverId,
        });
        if (binding) {
            bindings.push(binding);
        }
    }
    return bindings;
}

export function createVoiceSessionBindingStore() {
    // Ingestion and lookup share one projection of the metadata-bearing source slices.
    // Root storage notifications (messages, Machines, settings, etc.) cannot change
    // these bindings. Retain only the current inputs, never superseded snapshots.
    let persistedSource: Readonly<{
        sessions: NonNullable<SessionServerLookupStateLike>['sessions'];
        rows: NonNullable<SessionServerLookupStateLike>['sessionListRowsByServerId'];
        activeServerId: string;
        profilesGeneration: number;
    }> | null = null;
    let persistedBindings: ReadonlyArray<VoiceSessionBinding> = [];
    return createStore<VoiceSessionBindingStoreState>((set, get) => ({
        bindingsByConversationSessionId: {},
        runtimeBindingsByConversationSessionId: {},
        persistedBindingsByConversationSessionId: {},
        bind: (binding) =>
            set((state) => {
                const normalized = normalizeBinding(binding);
                if (!normalized) return state;
                if (areVoiceSessionBindingsEqual(
                    state.runtimeBindingsByConversationSessionId[normalized.conversationSessionId],
                    normalized,
                )) return state;
                const runtimeBindingsByConversationSessionId = upsertBindingRecord(
                    state.runtimeBindingsByConversationSessionId,
                    normalized,
                );
                return {
                    ...state,
                    runtimeBindingsByConversationSessionId,
                    bindingsByConversationSessionId: mergeVoiceConversationBindings(
                        runtimeBindingsByConversationSessionId,
                        state.persistedBindingsByConversationSessionId,
                    ),
                };
            }),
        unbind: (conversationSessionId) =>
            set((state) => {
                const normalized = normalizeId(conversationSessionId);
                if (!normalized) return state;
                if (!state.runtimeBindingsByConversationSessionId[normalized]) return state;
                const runtimeBindingsByConversationSessionId = { ...state.runtimeBindingsByConversationSessionId };
                delete runtimeBindingsByConversationSessionId[normalized];
                return {
                    ...state,
                    runtimeBindingsByConversationSessionId,
                    bindingsByConversationSessionId: mergeVoiceConversationBindings(
                        runtimeBindingsByConversationSessionId,
                        state.persistedBindingsByConversationSessionId,
                    ),
                };
            }),
        replacePersistedBindings: (bindings) =>
            set((state) => {
                const persistedBindingsByConversationSessionId = reconcileBindings(
                    state.persistedBindingsByConversationSessionId,
                    buildBindingsByConversationSessionId(bindings),
                );
                if (persistedBindingsByConversationSessionId === state.persistedBindingsByConversationSessionId) return state;
                return {
                    ...state,
                    persistedBindingsByConversationSessionId,
                    bindingsByConversationSessionId: reconcileBindings(
                        state.bindingsByConversationSessionId,
                        mergeVoiceConversationBindings(
                            state.runtimeBindingsByConversationSessionId,
                            persistedBindingsByConversationSessionId,
                        ),
                    ),
                };
            }),
        getByConversationSessionId: (conversationSessionId) => {
            const normalized = normalizeId(conversationSessionId);
            if (!normalized) return null;
            return get().bindingsByConversationSessionId[normalized] ?? null;
        },
        getByControlSessionId: (controlSessionId) => {
            const normalized = normalizeId(controlSessionId);
            if (!normalized) return null;
            let resolved: VoiceSessionBinding | null = null;
            for (const binding of Object.values(get().bindingsByConversationSessionId)) {
                if (binding.controlSessionId !== normalized) continue;
                resolved = pickNewerVoiceBinding(resolved, binding);
            }
            return resolved;
        },
        list: () => Object.values(get().bindingsByConversationSessionId),
        readPersistedBindings: (state) => {
            const sessions = state?.sessions;
            const rows = state?.sessionListRowsByServerId;
            const activeServerId = getActiveServerSnapshot().serverId;
            const profilesGeneration = getServerProfilesGeneration();
            if (!persistedSource || persistedSource.sessions !== sessions
                || persistedSource.rows !== rows || persistedSource.activeServerId !== activeServerId
                || persistedSource.profilesGeneration !== profilesGeneration) {
                persistedBindings = listPersistedBindingsFromState(state);
                persistedSource = { sessions, rows, activeServerId, profilesGeneration };
            }
            return persistedBindings;
        },
    }));
}

export const voiceSessionBindingStore = createVoiceSessionBindingStore();

/** Creates a fresh opaque owner for one runtime-attempt binding lifetime. */
export function createVoiceRuntimeAttemptBindingOwner(): object {
    return Object.freeze({});
}

/**
 * Bind through the canonical store while retaining an in-memory exact-owner
 * marker. Callers receive no authority over any binding they did not create.
 */
export function bindVoiceRuntimeAttemptBinding(input: Readonly<{
    binding: VoiceSessionBinding;
    owner: object;
    store?: typeof voiceSessionBindingStore;
}>): void {
    const store = input.store ?? voiceSessionBindingStore;
    store.getState().bind(withRuntimeAttemptBindingOwner(input.binding, input.owner));
}

/**
 * Remove a runtime-attempt binding only when the exact owner still occupies
 * the carrier. Same ids, same fields, and same timestamps are not ownership.
 */
export function unbindVoiceRuntimeAttemptBindingIfOwned(input: Readonly<{
    conversationSessionId: string;
    owner: object;
    store?: typeof voiceSessionBindingStore;
}>): boolean {
    const store = input.store ?? voiceSessionBindingStore;
    const conversationSessionId = normalizeId(input.conversationSessionId);
    if (!conversationSessionId) return false;

    let removed = false;
    store.setState((state) => {
        const current = state.runtimeBindingsByConversationSessionId[conversationSessionId] ?? null;
        if (!current || readRuntimeAttemptBindingOwner(current) !== input.owner) return state;

        const runtimeBindingsByConversationSessionId = {
            ...state.runtimeBindingsByConversationSessionId,
        };
        delete runtimeBindingsByConversationSessionId[conversationSessionId];
        removed = true;
        return {
            ...state,
            runtimeBindingsByConversationSessionId,
            bindingsByConversationSessionId: mergeVoiceConversationBindings(
                runtimeBindingsByConversationSessionId,
                state.persistedBindingsByConversationSessionId,
            ),
        };
    });
    return removed;
}

export function syncPersistedVoiceConversationBindings(params?: Readonly<{
    state?: SessionServerLookupStateLike;
    store?: typeof voiceSessionBindingStore;
}>): void {
    const nextState =
        params?.state
        ?? readRegisteredStorageState()
        ?? { sessions: {} };
    const store = params?.store ?? voiceSessionBindingStore;
    store.getState().replacePersistedBindings(store.getState().readPersistedBindings(nextState));
}

syncPersistedVoiceConversationBindings();

subscribeRegisteredStorageState((state, previousState) => {
    if (previousState && state.sessions === previousState.sessions
        && state.sessionListRowsByServerId === previousState.sessionListRowsByServerId) return;
    syncPersistedVoiceConversationBindings({ state });
});
subscribeActiveServer(() => syncPersistedVoiceConversationBindings());
subscribeServerProfiles(() => syncPersistedVoiceConversationBindings());
