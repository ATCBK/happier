import { SessionMessageAcceptedTurnV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';
import { projectFollowDeliveryV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowDeliveryProjectionV1';
import { isSessionFollowWakeEventLocalId } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';

/** Authenticated destination-only status; original source observations stay private. */
export function projectSessionFollowWakeBatchDelivery(row: Readonly<{
    localId: string | null;
    acceptedTurnKind?: string | null;
    acceptedTurnId?: string | null;
    turnStartWitnessId?: string | null;
}>) {
    if (!isSessionFollowWakeEventLocalId(row.localId)) return {};
    const parsed = SessionMessageAcceptedTurnV1Schema.safeParse({
        kind: row.acceptedTurnKind, turnId: row.acceptedTurnId,
    });
    // Event commit precedes provider effect. No accepted marker can also mean an
    // accepted effect whose ACK was lost, so it is not authoritative queue proof.
    if (!parsed.success) return { followDeliveryProjection: { status: null, reason: null } };
    return { followDeliveryProjection: projectFollowDeliveryV1({
        intent: 'wake', decision: { disposition: 'wake' },
        acceptedTurn: parsed.data,
        ...(row.turnStartWitnessId === parsed.data.turnId
            ? { acceptedTurnStartsNewTurn: true } : {}),
    }) };
}
