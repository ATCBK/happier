import type { z } from 'zod/mini';
import type { RunnerActivationCloseReasonV1Schema } from '@happier-dev/protocol/ephemeralRunner/activation';
import type { Tx } from '@/storage/inTx';

export const PREMATERIALIZED_RUNNER_ACTIVATION_STATES = ['pending', 'claimed', 'consented'];

/** Draft CAS precedes this conditional row update, which locks each activation. */
export async function closeDraftEphemeralRunnerActivationsInTx(
    tx: Tx,
    params: Readonly<{ creatorAccountId: string; draftId: string }>,
): Promise<void> {
    await tx.ephemeralRunnerActivation.updateMany({
        where: { ...params, state: { in: PREMATERIALIZED_RUNNER_ACTIVATION_STATES } },
        data: { state: 'closed', closeReason: 'canceled' },
    });
}

/** Conditional row update shares the activation lock with proof/currentness writers. */
export async function closeEphemeralRunnerActivationInTx(
    tx: Tx,
    params: Readonly<{ activationId: string; creatorAccountId: string; reason: z.infer<typeof RunnerActivationCloseReasonV1Schema> }>,
): Promise<void> {
    await tx.ephemeralRunnerActivation.updateMany({
        where: { id: params.activationId, creatorAccountId: params.creatorAccountId,
            state: { in: PREMATERIALIZED_RUNNER_ACTIVATION_STATES } },
        data: { state: 'closed', closeReason: params.reason },
    });
}

/**
 * Retires and removes every not-yet-materialized activation owned by an
 * Account that is being erased. Materialized activations remain the Session
 * deletion owner's responsibility, so an orphaned materialized row continues
 * to block Account deletion instead of being silently hidden by a cascade.
 */
export async function erasePrematerializedEphemeralRunnerActivationsForAccountInTx(
    tx: Tx,
    params: Readonly<{ creatorAccountId: string }>,
): Promise<void> {
    await tx.ephemeralRunnerActivation.updateMany({
        where: {
            creatorAccountId: params.creatorAccountId,
            state: { in: PREMATERIALIZED_RUNNER_ACTIVATION_STATES },
        },
        data: { state: 'closed', closeReason: 'revoked' },
    });
    await tx.ephemeralRunnerActivation.deleteMany({
        where: { creatorAccountId: params.creatorAccountId, state: 'closed' },
    });
}
