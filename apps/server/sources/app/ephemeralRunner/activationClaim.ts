import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { verifyRunnerClaimV1, type RunnerClaimV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { acquireAccountSessionOwnerMetadataFenceInTx, AccountSessionOwnerMetadataFenceAccountNotFoundError } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { inTx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { publishRunnerActivationChangedInTx } from './activationChanges';
import { readRunnerCreatorCurrentnessInTx, reconcileRunnerActivationCurrentnessInTx } from './activationCurrentness';
import { runnerActivationBinding } from './activationService';
import { acquireRunnerActivationLockInTx } from './activationLock';

export type ClaimEphemeralRunnerActivationResult =
    | Readonly<{ status: 'claimed'; claim: RunnerClaimV1 }>
    | Readonly<{ status: 'unavailable' }>;

/** One signed endpoint wins; exact replay cannot refresh the original creator epoch. */
export async function claimEphemeralRunnerActivation(
    params: Readonly<{ activationId: string; claim: unknown }>,
    options: Readonly<{ homeServerIdentityId: string }>,
): Promise<ClaimEphemeralRunnerActivationResult> {
    const preflight = await db.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId } });
    if (!preflight || preflight.homeServerIdentityId !== options.homeServerIdentityId
        || !verifyRunnerClaimV1({ claim: params.claim, expectedBinding: runnerActivationBinding(preflight) })) {
        return { status: 'unavailable' };
    }
    return await inTx(async (tx): Promise<ClaimEphemeralRunnerActivationResult> => {
        const initial = await tx.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId }, select: { creatorAccountId: true } });
        if (!initial) return { status: 'unavailable' };
        try {
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, initial.creatorAccountId, "content");
        } catch (error) {
            if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) return { status: 'unavailable' };
            throw error;
        }
        await acquireRunnerActivationLockInTx(tx, params.activationId);
        const row = await tx.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId } });
        if (!row || row.homeServerIdentityId !== options.homeServerIdentityId || row.state === 'closed' || row.state === 'materialized') return { status: 'unavailable' };
        const binding = runnerActivationBinding(row);
        const claim = verifyRunnerClaimV1({ claim: params.claim, expectedBinding: binding });
        if (!claim) return { status: 'unavailable' };
        const current = await readRunnerCreatorCurrentnessInTx(tx, row.creatorAccountId);
        if ((await reconcileRunnerActivationCurrentnessInTx(tx, row, current)).state === 'closed') return { status: 'unavailable' };
        if (row.claim !== null) {
            return pluginJsonValuesEqual(row.claim, claim) ? { status: 'claimed', claim } : { status: 'unavailable' };
        }
        if (row.state !== 'pending') return { status: 'unavailable' };
        await tx.ephemeralRunnerActivation.update({ where: { id: row.id }, data: { state: 'claimed', claim } });
        await publishRunnerActivationChangedInTx(tx, { creatorAccountId: row.creatorAccountId });
        return { status: 'claimed', claim };
    });
}
