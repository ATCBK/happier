import { z } from 'zod/mini';
import * as privacyKit from 'privacy-kit';
import type { BinaryBlobStoredContentV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import { encryptBytes, decryptBytes } from '@/modules/encrypt';
import { readEncryptionFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { readPrivateFile } from '@/storage/blob/files';

const PlainBinaryFileSchema = createStoredReadSchema(z.discriminatedUnion('t', [
    z.strictObject({ t: z.literal('plain'), v: z.string() }),
    z.strictObject({ t: z.literal('sealed_v1'), c: z.string() }),
]));

/** Resource adapters supply their established at-rest namespace, never authorization. */
export function storePrivateBinaryContent(path: string[], content: BinaryBlobStoredContentV1): Uint8Array {
    const bytes = new Uint8Array(privacyKit.decodeBase64(content.t === 'plain' ? content.v : content.c));
    if (content.t === 'encrypted') return bytes;
    const wrapper = readEncryptionFeatureEnv(process.env).plainAccountArtifactsAtRest === 'none'
        ? content : { t: 'sealed_v1', c: privacyKit.encodeBase64(encryptBytes(path, bytes)) };
    return new TextEncoder().encode(JSON.stringify(wrapper));
}

/** Explicit persisted mode selects decoding; opaque ciphertext never falls back to Plain. */
export async function openPrivateBinaryContent(path: string[], row: Readonly<{
    storageKey: string; encryptionMode: string;
}>): Promise<Uint8Array> {
    const stored = await readPrivateFile(row.storageKey);
    if (row.encryptionMode === 'e2ee') return stored;
    if (row.encryptionMode !== 'plain') throw new Error('Private binary content mode is unavailable');
    const parsed = PlainBinaryFileSchema.parse(JSON.parse(new TextDecoder().decode(stored)));
    return parsed.t === 'plain' ? new Uint8Array(privacyKit.decodeBase64(parsed.v))
        : new Uint8Array(decryptBytes(path, privacyKit.decodeBase64(parsed.c)));
}
