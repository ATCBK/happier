import {
    normalizeSessionAddress,
    sessionAddressKey,
    type SessionAddress,
} from '@/sync/domains/session/sessionAddress';
import type { ExecutionRunPublicState } from '@happier-dev/protocol';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange, subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';

/**
 * What the producer knows about the notification.
 *
 * `runId` is present when the producer observed one exact Run — the wire
 * `execution-run-updated` ephemeral carries the Run, and every Run mutation
 * names its target. A Session-level consumer ignores it; a surface mounted on
 * one exact Run uses it so a sibling Run's activity does not refetch it. `null`
 * means "unknown", and every listener then refreshes.
 */
export type ExecutionRunActivityNotification = Readonly<{
    runId: string | null;
}>;

type Listener = (notification: ExecutionRunActivityNotification) => void;

const UNKNOWN_RUN_NOTIFICATION: ExecutionRunActivityNotification = Object.freeze({ runId: null });

const listenersBySessionAddress = new Map<string, { address: SessionAddress; listeners: Set<Listener> }>();

const EMPTY_RUNNING_RUNS: readonly ExecutionRunPublicState[] = Object.freeze([]);
type RosterRead = () => Promise<readonly ExecutionRunPublicState[] | null>;
type Roster = {
    snapshot: readonly ExecutionRunPublicState[];
    listeners: Set<() => void>;
    read: RosterRead;
    request: object | null;
    invalidated: boolean;
    dispose: () => void;
};

// Demanded projections only: the host list remains authoritative. Every mounted
// consumer of one address shares its read and immutable snapshot; the last
// subscriber releases it, and a later mount starts with a new baseline.
const rostersBySessionAddress = new Map<string, Roster>();

function publishRoster(roster: Roster, runs: readonly ExecutionRunPublicState[]): void {
    const previousById = new Map(roster.snapshot.map((run) => [run.runId, run]));
    const next = runs.map((run) => {
        const previous = previousById.get(run.runId);
        return previous && JSON.stringify(previous) === JSON.stringify(run) ? previous : run;
    });
    if (next.length === roster.snapshot.length && next.every((run, index) => run === roster.snapshot[index])) return;
    roster.snapshot = next.length > 0 ? next : EMPTY_RUNNING_RUNS;
    for (const listener of [...roster.listeners]) listener();
}

function refreshRoster(key: string, roster: Roster): void {
    if (rostersBySessionAddress.get(key) !== roster) return;
    if (roster.request) {
        roster.invalidated = true;
        return;
    }
    const request = {};
    roster.request = request;
    roster.invalidated = false;
    void (async () => {
        try {
            const runs = await roster.read();
            if (rostersBySessionAddress.get(key) !== roster || roster.request !== request) return;
            // A failed/unavailable read cannot prove that the last-known runs
            // finished. Reconnect, activity or explicit refresh will catch up.
            if (runs !== null) publishRoster(roster, runs);
        } catch {
            // Keep the last-known projection until the next owner wake.
        } finally {
            if (rostersBySessionAddress.get(key) === roster && roster.request === request) {
                roster.request = null;
                if (roster.invalidated) refreshRoster(key, roster);
            }
        }
    })();
}

export function readRunningExecutionRunRoster(address: SessionAddress | null): readonly ExecutionRunPublicState[] {
    return address ? rostersBySessionAddress.get(sessionAddressKey(address))?.snapshot ?? EMPTY_RUNNING_RUNS : EMPTY_RUNNING_RUNS;
}

export function refreshRunningExecutionRunRoster(address: SessionAddress): void {
    const key = sessionAddressKey(address);
    const roster = rostersBySessionAddress.get(key);
    if (roster) refreshRoster(key, roster);
}

export function subscribeRunningExecutionRunRoster(
    address: SessionAddress,
    listener: () => void,
    read: RosterRead,
): () => void {
    const key = sessionAddressKey(address);
    let roster = rostersBySessionAddress.get(key);
    if (!roster) {
        const created: Roster = {
            snapshot: EMPTY_RUNNING_RUNS, listeners: new Set(), read,
            request: null, invalidated: false, dispose: () => {},
        };
        roster = created;
        rostersBySessionAddress.set(key, created);
        // Subscribe before reading so an event during the baseline schedules
        // one follow-up read rather than disappearing into the baseline gap.
        const unsubscribeActivity = subscribeExecutionRunActivity(address, () => refreshRoster(key, created));
        const unsubscribeCatchUp = subscribeHomeAccountChange((event) => {
            // Exact unrelated pages cannot change this Session's admission.
            // Own-Session and coarse wakes may change access/publication, even
            // when live Run ephemerals are correctly suppressed for the reader.
            if (event.entityIds !== undefined && !event.entityIds.includes(address.sessionId)) return;
            if (areServerProfileIdentifiersEquivalent(event.serverId, address.serverId)) refreshRoster(key, created);
        });
        const unsubscribeCredentials = subscribeHomeCredentialChange((event) => {
            if (!areServerProfileIdentifiersEquivalent(event.serverId, address.serverId)) return;
            // The existing credential owner retires Account data synchronously.
            // An old request may finish, but can no longer publish its rows.
            created.request = null;
            created.invalidated = false;
            publishRoster(created, EMPTY_RUNNING_RUNS);
            if (event.kind === 'credentials_set') refreshRoster(key, created);
        });
        created.dispose = () => {
            unsubscribeActivity();
            unsubscribeCatchUp();
            unsubscribeCredentials();
        };
    }
    const current = roster;
    current.listeners.add(listener);
    if (current.listeners.size === 1) refreshRoster(key, current);
    return () => {
        current.listeners.delete(listener);
        if (current.listeners.size > 0 || rostersBySessionAddress.get(key) !== current) return;
        rostersBySessionAddress.delete(key);
        current.dispose();
    };
}

export function notifyExecutionRunActivity(
    address: SessionAddress,
    notification: ExecutionRunActivityNotification = UNKNOWN_RUN_NOTIFICATION,
): void {
    const normalizedAddress = normalizeSessionAddress(address.serverId, address.sessionId);
    if (!normalizedAddress) return;

    const listeners = listenersBySessionAddress.get(sessionAddressKey(normalizedAddress))?.listeners;
    if (!listeners || listeners.size === 0) return;

    // Defensive copy: listeners may add/remove subscriptions while handling the notification.
    for (const listener of Array.from(listeners)) {
        try {
            listener(notification);
        } catch {
            // ignore listener errors
        }
    }
}

/**
 * Both Home sockets normalize content-free invalidation hints here. Do not
 * accept pushed Run state into the roster: its list reader owns that parsing.
 */
export function notifyExecutionRunActivityFromUpdate(
    serverId: string | null | undefined,
    update: unknown,
): void {
    if (!update || typeof update !== 'object'
        || !('type' in update) || update.type !== 'execution-run-updated'
        || !('sessionId' in update) || typeof update.sessionId !== 'string') return;
    const address = normalizeSessionAddress(serverId, update.sessionId);
    if (!address) return;
    const run = 'run' in update ? update.run : null;
    const runId = run && typeof run === 'object' && 'runId' in run && typeof run.runId === 'string'
        ? run.runId.trim() || null : null;
    notifyExecutionRunActivity(address, { runId });
}

/** Ephemerals have no replay cursor: every connection catches up demanded addresses. */
export function notifyExecutionRunActivityReconnect(serverId: string): void {
    for (const { address } of [...listenersBySessionAddress.values()]) {
        if (areServerProfileIdentifiersEquivalent(address.serverId, serverId)) notifyExecutionRunActivity(address);
    }
}

export function subscribeExecutionRunActivity(address: SessionAddress, listener: Listener): () => void {
    const normalizedAddress = normalizeSessionAddress(address.serverId, address.sessionId);
    if (!normalizedAddress) return () => {};

    const key = sessionAddressKey(normalizedAddress);
    const entry = listenersBySessionAddress.get(key) ?? { address: normalizedAddress, listeners: new Set<Listener>() };
    entry.listeners.add(listener);
    listenersBySessionAddress.set(key, entry);

    return () => {
        const current = listenersBySessionAddress.get(key);
        if (!current) return;
        current.listeners.delete(listener);
        if (current.listeners.size === 0) {
            listenersBySessionAddress.delete(key);
        }
    };
}
