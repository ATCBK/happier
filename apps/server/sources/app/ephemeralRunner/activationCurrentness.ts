import * as privacyKit from 'privacy-kit';
import type { RunnerEndpointFactsRecipientV1 } from '@happier-dev/protocol/ephemeralRunner/activation';
import { deriveAccountEncryptionCurrentnessFromRow } from '@/app/encryption/accountContentKeyAdmission';
import type { Tx } from '@/storage/inTx';
import { inTx } from '@/storage/inTx';
import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from '@/app/encryption/accountSessionOwnerMetadataFence';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { ActivationRow } from './activationService';
import { closeEphemeralRunnerActivationInTx, PREMATERIALIZED_RUNNER_ACTIVATION_STATES } from './activationLifecycle';

export type RunnerCreatorCurrentness =
    | Readonly<{ status: 'ready'; creatorTokenEpoch: number; endpointFactsRecipient: RunnerEndpointFactsRecipientV1 }>
    | Readonly<{ status: 'creator_unavailable' | 'recipient_mismatch' }>;

/** Observing a locked waiting attempt acknowledges revocation/expiry under Account admission. */
export async function reconcileRunnerActivationCurrentnessInTx(tx: Tx, row: ActivationRow, current: RunnerCreatorCurrentness): Promise<ActivationRow> {
    if (!PREMATERIALIZED_RUNNER_ACTIVATION_STATES.includes(row.state)) return row;
    const reason = current.status !== 'ready' || current.creatorTokenEpoch !== row.creatorTokenEpoch
        || !pluginJsonValuesEqual(current.endpointFactsRecipient, row.endpointFactsRecipient)
        ? 'revoked'
        : row.activationExpiresAt !== null && row.activationExpiresAt.getTime() <= Date.now() ? 'expired' : null;
    if (reason === null) return row;
    await closeEphemeralRunnerActivationInTx(tx, { activationId: row.id, creatorAccountId: row.creatorAccountId, reason });
    return { ...row, state: 'closed', closeReason: reason };
}

/** Adapts the existing Account authority while the caller holds Account admission. */
export async function readRunnerCreatorCurrentnessInTx(tx: Tx, creatorAccountId: string): Promise<RunnerCreatorCurrentness> {
    const account = await tx.account.findUnique({ where: { id: creatorAccountId },
        select: { id: true, status: true, tokenEpoch: true, encryptionMode: true, publicKey: true, contentPublicKey: true, contentPublicKeySig: true } });
    if (!account || account.status !== 'active') return { status: 'creator_unavailable' };
    const current = deriveAccountEncryptionCurrentnessFromRow(account);
    if (current.status !== 'ready') return { status: 'recipient_mismatch' };
    const facts = current.currentness;
    if (facts.encryptionMode === 'plain') {
        return { status: 'ready', creatorTokenEpoch: account.tokenEpoch, endpointFactsRecipient: { mode: 'plain', creatorAccountId } };
    }
    if (!account.publicKey || !facts.contentPublicKey || !facts.contentPublicKeySignature || !facts.contentPublicKeyFingerprint) {
        return { status: 'recipient_mismatch' };
    }
    return { status: 'ready', creatorTokenEpoch: account.tokenEpoch, endpointFactsRecipient: {
        mode: 'e2ee', creatorAccountId,
        accountSigningPublicKey: privacyKit.encodeBase64(Buffer.from(account.publicKey, 'hex'), 'base64url').replace(/=+$/u, ''),
        contentPublicKey: privacyKit.encodeBase64(facts.contentPublicKey, 'base64url').replace(/=+$/u, ''),
        contentPublicKeySignature: privacyKit.encodeBase64(facts.contentPublicKeySignature, 'base64url').replace(/=+$/u, ''),
        contentPublicKeyFingerprint: facts.contentPublicKeyFingerprint,
    } };
}

/** Authenticated creator projection of the existing Account encryption authority. */
export async function readRunnerCreatorRecipient(creatorAccountId: string): Promise<RunnerEndpointFactsRecipientV1 | null> {
    return inTx(async (tx) => {
        await acquireAccountSessionOwnerMetadataFenceInTx(tx, creatorAccountId, "content");
        const current = await readRunnerCreatorCurrentnessInTx(tx, creatorAccountId);
        return current.status === 'ready' ? current.endpointFactsRecipient : null;
    }).catch((error: unknown) => {
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) return null;
        throw error;
    });
}
