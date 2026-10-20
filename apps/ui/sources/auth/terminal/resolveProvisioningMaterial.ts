import {
    resolveTerminalProvisioningVariantV2,
    type TerminalProvisioningV2Response,
} from '@happier-dev/protocol/crypto/terminalProvisioningV2';
import tweetnacl from 'tweetnacl';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';

import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import {
    type AuthCredentials,
    isDataKeyAuthCredentials,
    isLegacyAuthCredentials,
} from '@/auth/storage/tokenStorage';
import { decodeBase64 } from '@/encryption/base64';

function equalBytesConstantTime(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left[index]! ^ right[index]!;
    }
    return difference === 0;
}

/** Authenticated persisted Account mode controls issuance; retained keys are historical custody. */
export async function resolveProvisioningMaterial(
    credentials: AuthCredentials,
    currentness: Pick<AccountEncryptionCurrentnessResponse, 'mode' | 'contentKeyFingerprint'> | null,
): Promise<TerminalProvisioningV2Response> {
    if (!currentness || (currentness.mode !== 'plain' && currentness.mode !== 'e2ee')) {
        throw new Error('Authenticated Account encryption mode is unavailable');
    }
    const variant = resolveTerminalProvisioningVariantV2({ encryptionMode: currentness.mode });
    if (variant === 'tokenOnly') return { type: 'tokenOnly' };
    if (!isDataKeyAuthCredentials(credentials) && !isLegacyAuthCredentials(credentials)) {
        throw new Error('Account encryption material is unavailable on this device');
    }

    if (isDataKeyAuthCredentials(credentials)) {
        const key = decodeBase64(credentials.encryption.machineKey, 'base64');
        if (key.length !== 32) throw new Error('Invalid data-key credential key length');
        const publicKey = decodeBase64(credentials.encryption.publicKey, 'base64');
        if (publicKey.length !== 32) throw new Error('Invalid data-key credential public key length');
        const derivedPublicKey = tweetnacl.box.keyPair.fromSecretKey(key).publicKey;
        if (!equalBytesConstantTime(publicKey, derivedPublicKey)) {
            throw new Error('Data-key credential public key does not match its machine scalar');
        }
    }

    const encryption = await createEncryptionFromAuthCredentials(credentials);
    const key = encryption.getContentPrivateKey();
    const fingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(key).publicKey);
    if (!currentness.contentKeyFingerprint || fingerprint !== currentness.contentKeyFingerprint) {
        throw new Error('Account encryption material does not match the current Account content key');
    }
    return { type: 'dataKey', key };
}
