import { activityInstanceKey, normalizeSessionAddress, type ActivityInstanceAddress } from './sessionAddress';
import { projectSessionAwarenessRuntimeV1 } from '@happier-dev/protocol/sessions/awareness/runtime';

export type SessionRuntimeObservation = Readonly<{
    active: boolean;
    thinking?: boolean;
    activeAt: number;
    presence?: 'online' | number;
}>;

/** Retained runtime observations formerly owned by ActivityUpdateAccumulator. */
export function createSessionRuntimeObservationSource() {
    const observations = new Map<string, SessionRuntimeObservation & { fullPublicationUpdatedAt?: number }>();
    const key = (address: ActivityInstanceAddress) => activityInstanceKey(address, 'ephemeral_activity_update');
    return {
        read: (address: ActivityInstanceAddress) => observations.get(key(address)),
        recordFullPublication: (address: ActivityInstanceAddress, updatedAt: number): void => {
            const previous = observations.get(key(address));
            if (!previous || updatedAt <= (previous.fullPublicationUpdatedAt ?? 0)) return;
            // Content currentness is independent of runtime sample ordering: a
            // newer ephemeral may already have supplied a later activeAt.
            observations.set(key(address), { ...previous, fullPublicationUpdatedAt: updatedAt });
        },
        forget: (address: ActivityInstanceAddress): void => { observations.delete(key(address)); },
        observe: (address: ActivityInstanceAddress, observation: SessionRuntimeObservation): boolean => {
            const previous = observations.get(key(address));
            if (previous && observation.activeAt < previous.activeAt) return false;
            const thinking = observation.thinking ?? previous?.thinking;
            if (previous && observation.activeAt === previous.activeAt && (
                (!previous.active && observation.active)
                || (previous.thinking === false && thinking === true)
            )) return false;
            observations.set(key(address), {
                active: observation.active,
                activeAt: observation.activeAt,
                thinking,
                presence: observation.presence ?? (observation.active
                    ? previous?.active === false ? undefined : previous?.presence
                    : observation.activeAt),
                ...(previous?.fullPublicationUpdatedAt !== undefined
                    ? { fullPublicationUpdatedAt: previous.fullPublicationUpdatedAt } : {}),
            });
            return true;
        },
        clear: () => observations.clear(),
    };
}

export type SessionRuntimeObservationSource = ReturnType<typeof createSessionRuntimeObservationSource>;

// The sole production Sync injects this source and owns its existing reset boundaries.
export const sessionRuntimeObservations = createSessionRuntimeObservationSource();

/** Finite request-local companion to inventory's captured immutable row baseline. */
export function captureSessionFullPublicationBaseline(serverId: string, sessionIds: readonly string[]): Readonly<Record<string, number | undefined>> {
    return Object.fromEntries(sessionIds.map((sessionId) => {
        const address = normalizeSessionAddress(serverId, sessionId);
        return [sessionId, address ? sessionRuntimeObservations.read(address)?.fullPublicationUpdatedAt : undefined];
    }));
}

/** A late receipt can change visible freshness even when active/thinking are unchanged. */
export function didSessionRuntimeObservationRecover(
    previous: (SessionRuntimeObservation & { archivedAt?: number | null }) | undefined,
    next: (SessionRuntimeObservation & { archivedAt?: number | null }) | undefined,
    nowMs: number,
): boolean {
    if (!previous || !next) return false;
    const freshness = (value: SessionRuntimeObservation & { archivedAt?: number | null }) => projectSessionAwarenessRuntimeV1({
        nowMs,
        lifecycle: { archivedAtMs: value.archivedAt },
        runtime: { active: value.active, thinking: value.thinking,
            presence: value.presence === 'online' ? 'online' : typeof value.presence === 'number' ? 'offline' : 'unknown',
            lastObservedAtMs: value.activeAt },
        pending: {},
    }).freshness;
    return freshness(previous) === 'stale' && freshness(next) === 'live';
}

/** Naked legacy ids cannot borrow another Home's observation; content time is never a witness. */
export function readSessionRuntimeObservation<T extends Readonly<{
    id?: string | null;
    serverId?: string | null;
    activeAt?: number | null;
    thinkingAt?: number | null;
    active?: boolean | null;
    thinking?: boolean | null;
    presence?: unknown;
}>>(input: T): T {
    const address = normalizeSessionAddress(input.serverId, input.id);
    const observed = address ? sessionRuntimeObservations.read(address) : undefined;
    if (!observed || observed.activeAt < (input.activeAt ?? 0)) return input;
    const active = observed.activeAt === input.activeAt
        ? observed.active && input.active !== false : observed.active;
    const thinking = observed.activeAt === input.thinkingAt
        ? observed.thinking === false || input.thinking === false ? false : observed.thinking ?? input.thinking
        : observed.activeAt > (input.thinkingAt ?? 0) ? observed.thinking ?? input.thinking : input.thinking;
    return {
        ...input,
        active,
        activeAt: observed.activeAt,
        // A delayed heartbeat cannot undo a later explicit thinking stop.
        thinking,
        thinkingAt: observed.thinking === true && observed.activeAt > (input.thinkingAt ?? 0)
            ? observed.activeAt : input.thinkingAt,
        // A newer attachment observation without device presence cannot borrow
        // an older content row's online marker as evidence for its fresh clock.
        presence: active ? observed.presence ?? (
            input.presence === 'online' && observed.activeAt > (input.activeAt ?? 0)
                ? undefined : input.presence
        )
            : typeof input.presence === 'number' ? input.presence : observed.activeAt,
    };
}
