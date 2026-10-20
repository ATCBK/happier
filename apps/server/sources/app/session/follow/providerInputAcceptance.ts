import { isSessionFollowWakeEventLocalId } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';

import type { Tx } from '@/storage/inTx';
import { readStoredSessionMessageDeliveryResolutionV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';

/**
 * Verifies that a Follow ACK names an admitted user input in the destination
 * Session transcript. Provider acceptance is observed by the daemon; this
 * durable identity check prevents either ordinary or Voice Follow from
 * settling a frontier for a fabricated or substituted input.
 */
export async function hasCanonicalFollowProviderInputAcceptanceInTx(
    tx: Tx,
    input: Readonly<{
        destinationSessionId: string;
        localInputId: string;
        userMessageSeq: number | null;
        requireProviderAccepted?: true;
    }>,
): Promise<boolean> {
    const message = await tx.sessionMessage.findUnique({
        where: {
            sessionId_localId: {
                sessionId: input.destinationSessionId,
                localId: input.localInputId,
            },
        },
        select: {
            seq: true,
            messageRole: true,
            acceptedTurnId: true,
            deliveryResolution: true,
        },
    });
    if (!message) return false;
    if (message.messageRole !== null && message.messageRole !== 'user') return false;
    if (input.requireProviderAccepted && !message.acceptedTurnId
        && readStoredSessionMessageDeliveryResolutionV1(message.deliveryResolution)?.kind !== 'provider_accepted') return false;
    return input.userMessageSeq === null || message.seq === input.userMessageSeq;
}

/**
 * Verifies the durable, destination-scoped event committed by the canonical
 * runtime transcript owner before a context-only Follow turn reaches a provider.
 * Event role and host observation provenance keep this distinct from user input
 * admission and from sidechain transcript material.
 */
export async function hasCanonicalFollowWakeEventAcceptanceInTx(
    tx: Tx,
    input: Readonly<{
        destinationSessionId: string;
        eventLocalId: string;
    }>,
): Promise<boolean> {
    if (!isSessionFollowWakeEventLocalId(input.eventLocalId)) return false;
    const message = await tx.sessionMessage.findUnique({
        where: {
            sessionId_localId: {
                sessionId: input.destinationSessionId,
                localId: input.eventLocalId,
            },
        },
        select: {
            sidechainId: true,
            messageRole: true,
            transcriptObservationProvenance: true,
        },
    });
    if (!message || message.sidechainId !== null || message.messageRole !== 'event') return false;
    const provenance = message.transcriptObservationProvenance;
    return typeof provenance === 'object'
        && provenance !== null
        && !Array.isArray(provenance)
        && 'kind' in provenance
        && provenance.kind === 'non_dependent'
        && 'source' in provenance
        && provenance.source === 'external';
}
