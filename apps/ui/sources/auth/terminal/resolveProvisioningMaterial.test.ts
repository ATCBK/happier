import { describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { encodeBase64 } from '@/encryption/base64';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import { resolveProvisioningMaterial } from './resolveProvisioningMaterial';

const plain = { mode: 'plain' as const, contentKeyFingerprint: null };
const e2ee = (key: Uint8Array) => ({ mode: 'e2ee' as const,
    contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(tweetnacl.box.keyPair.fromSecretKey(key).publicKey) });

describe('resolveProvisioningMaterial', () => {
    it('returns token-only for plain credentials', async () => {
        await expect(resolveProvisioningMaterial({ token: 't' }, plain)).resolves.toEqual({ type: 'tokenOnly' });
    });

    it('keeps retained historical keys out of plain Account provisioning', async () => {
        await expect(resolveProvisioningMaterial({ token: 't', secret: encodeBase64(new Uint8Array(32).fill(4), 'base64url') }, plain))
            .resolves.toEqual({ type: 'tokenOnly' });
    });

    it('refuses E2EE provisioning without a genuine key and refuses an unknown mode', async () => {
        await expect(resolveProvisioningMaterial({ token: 't' }, e2ee(new Uint8Array(32).fill(3)))).rejects.toThrow();
        await expect(resolveProvisioningMaterial({ token: 't' }, null)).rejects.toThrow();
    });

    it('retains a valid data key', async () => {
        const key = new Uint8Array(32).fill(3);
        const publicKey = tweetnacl.box.keyPair.fromSecretKey(key).publicKey;
        await expect(resolveProvisioningMaterial({
            token: 't',
            encryption: { publicKey: encodeBase64(publicKey), machineKey: encodeBase64(key) },
        }, e2ee(new Uint8Array(32).fill(3)))).resolves.toEqual({ type: 'dataKey', key });
    });

    it('rejects data-key credentials whose public key does not derive from the machine scalar', async () => {
        const key = new Uint8Array(32).fill(3);
        await expect(resolveProvisioningMaterial({
            token: 't',
            encryption: { publicKey: encodeBase64(new Uint8Array(32).fill(9)), machineKey: encodeBase64(key) },
        }, e2ee(new Uint8Array(32).fill(3)))).rejects.toThrow('public key does not match');
    });

    it('resolves secret credentials to the same dataKey material as the canonical encryption owner', async () => {
        const secret = new Uint8Array(32).fill(4);
        const credentials = { token: 't', secret: encodeBase64(secret, 'base64url') } as const;
        const canonical = (await createEncryptionFromAuthCredentials(credentials)).getContentPrivateKey();
        expect(canonical).not.toEqual(secret);
        await expect(resolveProvisioningMaterial(credentials, e2ee(canonical))).resolves.toEqual({ type: 'dataKey', key: canonical });
    });

    it('rejects malformed secret credentials instead of issuing material', async () => {
        await expect(resolveProvisioningMaterial({
            token: 't',
            secret: encodeBase64(new Uint8Array(16).fill(4), 'base64url'),
        }, e2ee(new Uint8Array(32).fill(3)))).rejects.toThrow('Invalid secret key length');
    });
    it('refuses a retained key that differs from the current Account content fingerprint', async () => {
        const key = new Uint8Array(32).fill(3);
        await expect(resolveProvisioningMaterial({ token: 't', encryption: {
            publicKey: encodeBase64(tweetnacl.box.keyPair.fromSecretKey(key).publicKey), machineKey: encodeBase64(key),
        } }, { mode: 'e2ee', contentKeyFingerprint: 'aemk1_another-key' })).rejects.toThrow();
    });
    it('refuses E2EE material without a comparable current content fingerprint', async () => {
        await expect(resolveProvisioningMaterial({ token: 't', secret: encodeBase64(new Uint8Array(32).fill(4)) },
            { mode: 'e2ee', contentKeyFingerprint: null })).rejects.toThrow();
    });

});
