import type { Message } from "@happier-dev/session-core/messages";
import { isRecoveredHistoryTranscriptObservation } from "@happier-dev/session-core/messages";
import type { DiscardedPendingMessage, PendingMessage } from '../../domains/state/storageTypes';
import { shouldPreservePendingProjectionAfterCommittedUserLocalId } from '../../domains/pending/pendingTranscriptProjection';
import { isPendingMessageForRecipient } from '../../domains/pending/pendingMessageRecipient';

import type { StoreGet, StoreSet } from './_shared';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type SessionPending = {
    messages: PendingMessage[];
    discarded: DiscardedPendingMessage[];
    isLoaded: boolean;
    /** Initial main-queue read; settlement never fabricates a loaded or empty snapshot. */
    readState?: 'loading' | 'error';
};

export type PendingDomain = {
    sessionPending: Record<string, SessionPending>;
    setPendingReadState: (sessionId: string, readState: NonNullable<SessionPending['readState']>) => void;
    applyPendingLoaded: (sessionId: string) => void;
    applyPendingSnapshot: (sessionId: string, snapshot: Readonly<{
        messages: PendingMessage[];
        discarded: DiscardedPendingMessage[];
    }>) => void;
    applyPendingMessages: (sessionId: string, messages: PendingMessage[]) => void;
    applyDiscardedPendingMessages: (sessionId: string, messages: DiscardedPendingMessage[]) => void;
    pruneServerPendingMessages: (sessionId: string) => void;
    upsertPendingMessage: (sessionId: string, message: PendingMessage) => void;
    removePendingMessage: (sessionId: string, pendingId: string) => void;
};

type PendingDomainDependencies = {
    sessionMessages?: Record<string, {
        messagesById?: Record<string, Message>;
        messagesMap?: Record<string, Message>;
    } | undefined>;
};

function collectCommittedUserLocalIds<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    candidateLocalIds: ReadonlySet<string>,
): Set<string> {
    if (candidateLocalIds.size === 0) return new Set();

    const sessionMessages = state.sessionMessages?.[sessionId];
    const messagesById = sessionMessages?.messagesById ?? sessionMessages?.messagesMap;
    if (!messagesById) return new Set();

    const committed = new Set<string>();
    for (const message of Object.values(messagesById)) {
        if (
            message?.kind !== 'user-text'
            || isRecoveredHistoryTranscriptObservation(message)
        ) continue;
        const localId = typeof message.localId === 'string' ? message.localId : '';
        if (localId && candidateLocalIds.has(localId)) {
            committed.add(localId);
        }
    }
    return committed;
}

function filterUncommittedPendingMessages<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    messages: PendingMessage[],
): PendingMessage[] {
    const candidateLocalIds = new Set<string>();
    for (const message of messages) {
        if (message.localId) candidateLocalIds.add(message.localId);
    }

    const committedLocalIds = collectCommittedUserLocalIds(state, sessionId, candidateLocalIds);
    if (committedLocalIds.size === 0) return messages;

    return messages.filter((message) => (
        !message.localId
        || !committedLocalIds.has(message.localId)
        || shouldPreservePendingProjectionAfterCommittedUserLocalId(message)
    ));
}

/**
 * The other half of {@link filterUncommittedPendingMessages}, at the same owner.
 *
 * That filter can DROP a pending projection once its committed twin exists, but it can never add
 * one, so it only closes the "both rows" hole. This closes the "neither row" hole: a bulk server
 * write speaks for exactly the rows it names, and a locally owned direct-send projection is not one
 * of them ({@link isLocallyOwnedUncommittedOutboundProjection}). Dropping it because a snapshot
 * omitted it publishes a transcript with neither row for that utterance.
 *
 * `sync/engine/pending/pendingQueueV2.ts#shouldPreserveUnscopedLocalOutbound` answers a DIFFERENT
 * question one layer up — which rows a given snapshot speaks for — and normally means the store
 * never sees such a snapshot at all. This is the store's own invariant, not a second copy of that
 * decision: the store may not drop a row it owns, whoever hands it the snapshot.
 */
function retainLocallyOwnedOutboundProjections<S extends PendingDomain & PendingDomainDependencies>(
    state: S,
    sessionId: string,
    nextMessages: PendingMessage[],
    nextDiscarded: readonly DiscardedPendingMessage[],
): PendingMessage[] {
    const existing = state.sessionPending[sessionId]?.messages;
    if (!existing || existing.length === 0) return nextMessages;

    const serverKnownIds = new Set<string>();
    const serverKnownLocalIds = new Set<string>();
    for (const message of [...nextMessages, ...nextDiscarded]) {
        serverKnownIds.add(message.id);
        serverKnownLocalIds.add(message.localId ?? message.id);
    }
    const retained = existing.filter((message) => (
        !serverKnownIds.has(message.id)
        && !serverKnownLocalIds.has(message.localId ?? message.id)
        && isLocallyOwnedUncommittedOutboundProjection(state, sessionId, message)
    ));
    if (retained.length === 0) return nextMessages;
    return [...nextMessages, ...retained];
}

function isPendingMessageAlreadyCommitted<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    message: PendingMessage,
): boolean {
    if (!message.localId) return false;
    if (shouldPreservePendingProjectionAfterCommittedUserLocalId(message)) return false;
    return collectCommittedUserLocalIds(state, sessionId, new Set([message.localId])).size > 0;
}

/**
 * A LOCALLY OWNED outbound projection the server pending queue never learned about.
 *
 * `pruneServerPendingMessages` retires every projection the server queue speaks for. A DIRECT send
 * (`sync/sync.ts`, active-session RPC/socket accept) creates a projection the queue never learns
 * about: a `pending-changed` count of 0 says nothing about it. Retiring it there publishes a
 * transcript frame carrying NEITHER row for that utterance — the list renders one row shorter than
 * both the before and the after state, which is the send flicker seen from the data side.
 *
 * Such a row is retired by the ARRIVAL of its committed twin (`applyMessages` does that in one store
 * update), never by server pending state, which never owned it.
 *
 * "Locally owned" is checked, not assumed:
 *  - `pendingOutboxScope` present means the row is a DURABLE outbox projection and the server queue
 *    addresses it through that scope, so server pending state IS authoritative for it.
 *  - `pendingDeliveryStatus` present means the server has already reported on this row's delivery,
 *    so the queue knows it and may retire it.
 *  - `deliveryStatus` is deliberately NOT consulted: it records how far THIS device's send has got,
 *    not who owns the row, and a send spends real time in every one of its states. Consulting it
 *    would disagree with `pendingQueueV2#shouldPreserveUnscopedLocalOutbound`, which preserves an
 *    unscoped `local_outbound` row the snapshot does not name regardless of `deliveryStatus`.
 *
 * A retention rule about ownership, not a delay: the row leaves the moment its twin EXISTS, and an
 * owner-driven retirement (cancel, discard, delete, send failure) still removes it immediately
 * through `removePendingMessage`.
 */
function isLocallyOwnedUncommittedOutboundProjection<S extends PendingDomainDependencies>(
    state: S,
    sessionId: string,
    message: PendingMessage,
): boolean {
    if (message.source !== 'local_outbound') return false;
    if (message.pendingOutboxScope !== undefined) return false;
    if (message.pendingDeliveryStatus !== undefined) return false;
    const localId = message.localId ?? message.id;
    if (!localId) return false;
    return collectCommittedUserLocalIds(state, sessionId, new Set([localId])).size === 0;
}

function reconcilePendingMessages<T extends { id: string }>(previous: T[], incoming: T[]): T[] {
    if (sameStrictJsonValue(previous, incoming)) return previous;
    const byId = new Map(previous.map(message => [message.id, message]));
    return incoming.map(message => {
        const known = byId.get(message.id);
        return known && sameStrictJsonValue(known, message) ? known : message;
    });
}

function replacePendingBucket<S extends PendingDomain & PendingDomainDependencies>(
    state: S,
    sessionId: string,
    snapshot: Readonly<{
        messages: PendingMessage[];
        discarded: DiscardedPendingMessage[];
        isLoaded: boolean;
    }>,
): S {
    const filteredMessages = retainLocallyOwnedOutboundProjections(
        state,
        sessionId,
        filterUncommittedPendingMessages(state, sessionId, snapshot.messages),
        snapshot.discarded,
    );
    const existing = state.sessionPending[sessionId];
    const previousMessages = existing?.messages ?? [];
    const previousDiscarded = existing?.discarded ?? [];
    const nextMessages = reconcilePendingMessages(previousMessages, filteredMessages);
    const nextDiscarded = reconcilePendingMessages(previousDiscarded, snapshot.discarded);
    if (
        existing
        && nextMessages === previousMessages
        && nextDiscarded === previousDiscarded
        && existing.isLoaded === snapshot.isLoaded
        && (existing.readState === undefined || !snapshot.isLoaded)
    ) {
        return state;
    }
    return {
        ...state,
        sessionPending: {
            ...state.sessionPending,
            [sessionId]: {
                messages: nextMessages,
                discarded: nextDiscarded,
                isLoaded: snapshot.isLoaded,
                ...(!snapshot.isLoaded && existing?.readState ? { readState: existing.readState } : {}),
            },
        },
    };
}

export function createPendingDomain<S extends PendingDomain & PendingDomainDependencies>({
    set,
    get: _get,
}: {
    set: StoreSet<S>;
    get: StoreGet<S>;
}): PendingDomain {
    return {
        sessionPending: {},
        setPendingReadState: (sessionId, readState) => set(state => {
            const existing = state.sessionPending[sessionId];
            if (existing?.isLoaded || existing?.readState === readState) return state;
            return { ...state, sessionPending: { ...state.sessionPending, [sessionId]: {
                ...(existing ?? { messages: [], discarded: [], isLoaded: false }), readState,
            } } };
        }),
        applyPendingLoaded: (sessionId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (existing?.isLoaded === true) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        messages: existing?.messages ?? [],
                        discarded: existing?.discarded ?? [],
                        isLoaded: true,
                    }
                }
            };
        }),
        applyPendingSnapshot: (sessionId, snapshot) => set((state) => replacePendingBucket(state, sessionId, {
            ...snapshot,
            isLoaded: true,
        })),
        applyPendingMessages: (sessionId, messages) => set((state) => replacePendingBucket(state, sessionId, {
            messages,
            discarded: state.sessionPending[sessionId]?.discarded ?? [],
            isLoaded: true,
        })),
        applyDiscardedPendingMessages: (sessionId, discarded) => set((state) => replacePendingBucket(state, sessionId, {
            messages: state.sessionPending[sessionId]?.messages ?? [],
            discarded,
            isLoaded: state.sessionPending[sessionId]?.isLoaded ?? false,
        })),
        pruneServerPendingMessages: (sessionId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (!existing || existing.messages.length === 0) return state;
            const nextMessages = existing.messages.filter((message) => {
                // `pendingCount` counts the MAIN queue only (server pending state I08); a Run-scoped
                // enqueue on a Session whose main queue is empty publishes `pendingCount: 0`. The
                // receipt for an exact Run target is that target's own snapshot refresh
                // (`sync/engine/socket/socket.ts` pending-changed → `fetchPendingMessages(…, recipient)`),
                // never this main-queue count, so rows addressed to a Run are left alone here.
                if (!isPendingMessageForRecipient(message, undefined)) return true;
                if (message.source === 'server_pending') return false;
                // The server pending queue never spoke for this row, so a queue-empty notice is not
                // a receipt for it. Retiring it here is the "neither row" frame.
                if (isLocallyOwnedUncommittedOutboundProjection(state, sessionId, message)) return true;
                const acceptedOrdinaryServerProjection =
                    message.source === 'local_outbound'
                    && message.deliveryStatus === 'accepted'
                    && message.pendingOutboxOperation === undefined
                    && (
                        message.pendingDeliveryStatus === undefined
                        || message.pendingDeliveryStatus === 'server_queued'
                        || message.pendingDeliveryStatus === 'server_delivering'
                    );
                return !acceptedOrdinaryServerProjection;
            });
            if (nextMessages.length === existing.messages.length) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        ...existing,
                        messages: nextMessages,
                    },
                },
            };
        }),
        upsertPendingMessage: (sessionId: string, message: PendingMessage) => set((state) => {
            if (isPendingMessageAlreadyCommitted(state, sessionId, message)) {
                return state;
            }
            const existing = state.sessionPending[sessionId] ?? { messages: [], discarded: [], isLoaded: false };
            const idx = existing.messages.findIndex((m) => m.id === message.id);
            if (idx >= 0 && sameStrictJsonValue(existing.messages[idx], message)) {
                return state;
            }
            const next = idx >= 0
                ? [...existing.messages.slice(0, idx), message, ...existing.messages.slice(idx + 1)]
                : [...existing.messages, message];
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        ...existing,
                        messages: next,
                        discarded: existing.discarded,
                        isLoaded: existing.isLoaded
                    }
                }
            };
        }),
        removePendingMessage: (sessionId: string, pendingId: string) => set((state) => {
            const existing = state.sessionPending[sessionId];
            if (!existing) return state;
            if (!existing.messages.some((message) => message.id === pendingId)) return state;
            return {
                ...state,
                sessionPending: {
                    ...state.sessionPending,
                    [sessionId]: {
                        ...existing,
                        messages: existing.messages.filter((m) => m.id !== pendingId)
                    }
                }
            };
        }),
    };
}
