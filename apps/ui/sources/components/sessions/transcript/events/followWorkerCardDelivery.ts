import type { FollowDeliveryProjectionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowDeliveryProjectionV1';

type DeliveryMessage = Readonly<{ localId?: string | null; followDeliveryProjection?: FollowDeliveryProjectionV1 }>;

const UNKNOWN_DELIVERY: FollowDeliveryProjectionV1 = { status: null, reason: null };

/** Index only already-projected, exact input/batch messages; card events are never evidence by proximity. */
export function indexFollowDeliveryByLocalId(messages: Readonly<Record<string, DeliveryMessage>>): ReadonlyMap<string, FollowDeliveryProjectionV1 | null> {
    const byLocalId = new Map<string, FollowDeliveryProjectionV1 | null>();
    for (const message of Object.values(messages)) {
        const localId = message.localId;
        const projection = message.followDeliveryProjection;
        if (!localId || !projection) continue;
        const previous = byLocalId.get(localId);
        if (previous === undefined) byLocalId.set(localId, projection);
        else if (previous && (previous.status !== projection.status || previous.reason !== projection.reason)) byLocalId.set(localId, null);
    }
    return byLocalId;
}

export function projectWorkerCardDelivery(event: Readonly<{
    followInputLocalId?: string;
    followWakeEventLocalId?: string;
    ownProjection?: FollowDeliveryProjectionV1;
}>, byLocalId: ReadonlyMap<string, FollowDeliveryProjectionV1 | null>): FollowDeliveryProjectionV1 {
    const correlatedLocalId = event.followInputLocalId ?? event.followWakeEventLocalId;
    if (correlatedLocalId) return byLocalId.get(correlatedLocalId) ?? UNKNOWN_DELIVERY;
    return event.ownProjection ?? UNKNOWN_DELIVERY;
}
