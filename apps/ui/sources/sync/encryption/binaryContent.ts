import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { BinaryBlobReferenceV1Schema, BinaryBlobStoredContentV1Schema,
    type BinaryBlobReferenceV1, type BinaryBlobStoredContentV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { HappyError } from '@/utils/errors/errors';
import { AES256Encryption } from './encryptor';

export type BinaryContentEncryption = Readonly<{
    encryptBytes: (bytes: Uint8Array) => Promise<string>;
    decryptBytes: (ciphertext: string) => Promise<Uint8Array>;
}>;

/** Resource adapters supply their admitted DEK; this codec owns only byte framing. */
export function createBinaryContentEncryption(dataKey: Uint8Array): BinaryContentEncryption {
    const cipher = new AES256Encryption(dataKey);
    return {
        encryptBytes: async bytes => encodeBase64(await cipher.encryptBytes(bytes), 'base64'),
        decryptBytes: ciphertext => cipher.decryptBytes(decodeBase64(ciphertext, 'base64')),
    };
}

export function hashBinaryContent(bytes: Uint8Array): string {
    return bytesToHex(sha256(bytes));
}

export async function sealBinaryContent(bytes: Uint8Array, mode: 'plain' | 'e2ee', encryption: BinaryContentEncryption | null): Promise<BinaryBlobStoredContentV1> {
    if (mode === 'plain') return { t: 'plain', v: encodeBase64(bytes) };
    if (!encryption) throw new HappyError('File encryption material is unavailable', false, { code: 'binary_content_unavailable' });
    return { t: 'encrypted', c: await encryption.encryptBytes(bytes) };
}

/** Explicit mode and plaintext integrity are checked before returning any bytes. */
export async function openBinaryContent(input: Readonly<{
    reference: BinaryBlobReferenceV1;
    content: BinaryBlobStoredContentV1;
    mode: 'plain' | 'e2ee';
    encryption: BinaryContentEncryption | null;
}>): Promise<Uint8Array> {
    const reference = BinaryBlobReferenceV1Schema.parse(input.reference);
    const content = BinaryBlobStoredContentV1Schema.parse(input.content);
    if ((input.mode === 'plain') !== (content.t === 'plain')) throw new HappyError('File does not match its resource mode', false,
        { code: 'binary_account_mode_mismatch' });
    let bytes: Uint8Array;
    try {
        if (content.t === 'plain') bytes = decodeBase64(content.v);
        else {
            if (!input.encryption) throw new Error('Encryption material unavailable');
            bytes = await input.encryption.decryptBytes(content.c);
        }
    } catch {
        throw new HappyError('File content is unavailable', false, { code: 'binary_content_unavailable' });
    }
    if (bytes.length !== reference.sizeBytes || hashBinaryContent(bytes) !== reference.sha256) throw new HappyError('File integrity check failed', false,
        { code: 'binary_content_unavailable' });
    return bytes;
}
