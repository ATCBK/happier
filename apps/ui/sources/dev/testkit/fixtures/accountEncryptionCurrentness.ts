import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';

/** A real data-key Account's currentness, matching the client's actual material. */
export function createDataKeyAccountEncryptionCurrentnessFixture(input: Readonly<{
    machineKey: Uint8Array;
    publicKey: Uint8Array;
}>): AccountEncryptionCurrentnessResponse {
    const snapshot = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'dataKey', machineKey: input.machineKey }, dataKeyPublicKey: input.publicKey });
    return { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing',
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(snapshot.contentPublicKeyFingerprint),
        updatedAt: 1, recipientEnvelopeReadiness: { status: 'available' } };
}

/**
 * Canonical plain-Account currentness response for UI boundary harnesses.
 * Plain Accounts intentionally have no recipient encryption envelope.
 */
export function createPlainAccountEncryptionCurrentnessFixture(input: Readonly<{
    version?: number;
    settingsVersion?: number;
    updatedAt?: number;
}> = {}): AccountEncryptionCurrentnessResponse {
    return Object.freeze({
        mode: 'plain',
        version: input.version ?? 1,
        ...(input.settingsVersion === undefined ? {} : { settingsVersion: input.settingsVersion }),
        signingKeyFingerprint: null,
        contentKeyFingerprint: null,
        updatedAt: input.updatedAt ?? 1,
        recipientEnvelopeReadiness: Object.freeze({
            status: 'unavailable',
            reason: 'plain_account',
        }),
    });
}
