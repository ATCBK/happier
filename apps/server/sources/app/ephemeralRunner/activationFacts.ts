import { isStoredJsonContentEnvelopeModeCompatible } from '@happier-dev/protocol/storage/storedJsonContentEnvelope';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { verifyRunnerEndpointFactsV1, type RunnerEndpointFactsV1 } from '@happier-dev/protocol/ephemeralRunner/endpoint';
import { acquireAccountSessionOwnerMetadataFenceInTx, AccountSessionOwnerMetadataFenceAccountNotFoundError } from '@/app/encryption/accountSessionOwnerMetadataFence';
import { inTx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { publishRunnerActivationChangedInTx } from './activationChanges';
import { readRunnerCreatorCurrentnessInTx, reconcileRunnerActivationCurrentnessInTx } from './activationCurrentness';
import { runnerActivationBinding } from './activationService';
import { acquireRunnerActivationLockInTx } from './activationLock';

export type StoreRunnerEndpointFactsResult =
    | Readonly<{ status: 'stored'; endpointFacts: RunnerEndpointFactsV1 }>
    | Readonly<{ status: 'unavailable' | 'content_mode_mismatch' | 'conflict' }>;

/** The claimed installation publishes exact signed facts under admission and the activation lock. */
export async function storeRunnerEndpointFacts(
    params: Readonly<{ activationId: string; endpointFacts: unknown }>,
    options: Readonly<{ homeServerIdentityId: string }>,
): Promise<StoreRunnerEndpointFactsResult> {
    const preflight = await db.ephemeralRunnerActivation.findUnique({ where: { id: params.activationId } });
    if (!preflight || preflight.homeServerIdentityId !== options.homeServerIdentityId
        || !verifyRunnerEndpointFactsV1({ endpointFacts: params.endpointFacts, claim: preflight.claim, expectedBinding: runnerActivationBinding(preflight) })) {
        return { status: 'unavailable' };
    }
    return await inTx(async (tx): Promise<StoreRunnerEndpointFactsResult> => {
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
        if (!row || row.homeServerIdentityId !== options.homeServerIdentityId
            || (row.state !== 'claimed' && row.state !== 'consented')) return { status: 'unavailable' };
        const facts = verifyRunnerEndpointFactsV1({ endpointFacts: params.endpointFacts, claim: row.claim, expectedBinding: runnerActivationBinding(row) });
        if (!facts) return { status: 'unavailable' };
        const current = await readRunnerCreatorCurrentnessInTx(tx, row.creatorAccountId);
        if ((await reconcileRunnerActivationCurrentnessInTx(tx, row, current)).state === 'closed' || current.status !== 'ready') return { status: 'unavailable' };
        if (!isStoredJsonContentEnvelopeModeCompatible(current.endpointFactsRecipient.mode, facts.payload.content)) return { status: 'content_mode_mismatch' };
        if (row.endpointFacts !== null && pluginJsonValuesEqual(row.endpointFacts, facts)) return { status: 'stored', endpointFacts: facts };
        if (row.state !== 'claimed' || row.review !== null) return { status: 'conflict' };
        await tx.ephemeralRunnerActivation.update({ where: { id: row.id }, data: { endpointFacts: facts } });
        await publishRunnerActivationChangedInTx(tx, { creatorAccountId: row.creatorAccountId });
        return { status: 'stored', endpointFacts: facts };
    });
}
