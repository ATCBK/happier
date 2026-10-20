import { ENCRYPTED_DATA_KEY_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { encodeBase64 } from '@/encryption/base64';
import { getRandomBytes } from '@/platform/cryptoRandom';

export type ResourceDataKey =
    | Readonly<{ mode: 'plain'; dataKey: null; dataEncryptionKey: null }>
    | Readonly<{ mode: 'e2ee'; dataKey: Uint8Array; dataEncryptionKey: string }>;

export type ResourceDataKeySealer = (dataKey: Uint8Array) => Promise<Uint8Array | null>;
export type ResourceDataKeyOpener = (encryptedDataKey: string) => Promise<Uint8Array | null>;

/** The admitted mode owns representation; resource content uses an independent DEK. */
export async function createResourceDataKey(input: Readonly<{
    mode: 'plain' | 'e2ee';
    encryptDataEncryptionKey?: ResourceDataKeySealer;
}>): Promise<ResourceDataKey | null> {
    if (input.mode === 'plain') return { mode: 'plain', dataKey: null, dataEncryptionKey: null };
    if (!input.encryptDataEncryptionKey) return null;
    const dataKey = getRandomBytes(ENCRYPTED_DATA_KEY_V1_BYTES);
    const envelope = await input.encryptDataEncryptionKey(dataKey);
    return envelope instanceof Uint8Array
        ? { mode: 'e2ee', dataKey, dataEncryptionKey: encodeBase64(envelope, 'base64') }
        : null;
}

/** Opens only the envelope supplied by the authorized resource, never an anchor key. */
export async function openResourceDataKey(input: Readonly<{
    mode: 'plain' | 'e2ee';
    dataEncryptionKey: string | null;
    decryptDataEncryptionKey?: ResourceDataKeyOpener;
}>): Promise<ResourceDataKey | null> {
    if (input.mode === 'plain') return input.dataEncryptionKey === null
        ? { mode: 'plain', dataKey: null, dataEncryptionKey: null } : null;
    if (!input.dataEncryptionKey || !input.decryptDataEncryptionKey) return null;
    const dataKey = await input.decryptDataEncryptionKey(input.dataEncryptionKey);
    return dataKey?.length === ENCRYPTED_DATA_KEY_V1_BYTES
        ? { mode: 'e2ee', dataKey, dataEncryptionKey: input.dataEncryptionKey } : null;
}
