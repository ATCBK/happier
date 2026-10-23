import { createHash } from 'node:crypto';
import { BinaryBlobStoredContentV1Schema, type BinaryBlobReferenceV1, type BinaryBlobStoredContentV1 } from '@happier-dev/protocol/storage/binaryBlobV1';
import { frameSessionDataKeyBundleV0, readSessionDataKeyBundleV0 } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { sealAesGcmPayloadWebCrypto, openAesGcmPayloadWebCrypto } from '@happier-dev/protocol/crypto/sessionDataKeyBundleWebCrypto';
import { decodeBase64, encodeBase64 } from '@/api/encryption';

type ResourceBinaryKey = Readonly<{ mode: 'plain' | 'e2ee'; dataKey: Uint8Array | null }>;

/** Common byte codec; each resource retains its own binding, grants and key opening. */
export async function sealResourceBinaryContent(key: ResourceBinaryKey, bytes: Uint8Array): Promise<BinaryBlobStoredContentV1> {
  if (key.mode === 'plain') return { t: 'plain', v: encodeBase64(bytes) };
  if (!key.dataKey) throw new Error('resource_binary_content_unavailable');
  return { t: 'encrypted', c: encodeBase64(frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(bytes, key.dataKey))) };
}

export async function openResourceBinaryContent(key: ResourceBinaryKey, reference: BinaryBlobReferenceV1, raw: unknown): Promise<Uint8Array> {
  const content = BinaryBlobStoredContentV1Schema.parse(raw);
  if ((key.mode === 'plain') !== (content.t === 'plain')) throw new Error('resource_binary_content_unavailable');
  let bytes: Uint8Array;
  if (content.t === 'plain') bytes = decodeBase64(content.v);
  else {
    if (!key.dataKey) throw new Error('resource_binary_content_unavailable');
    const bundle = readSessionDataKeyBundleV0(decodeBase64(content.c));
    if (bundle.status !== 'ready') throw new Error('resource_binary_content_unavailable');
    bytes = await openAesGcmPayloadWebCrypto(bundle.payload, key.dataKey);
  }
  if (bytes.byteLength !== reference.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
    throw new Error('resource_binary_content_unavailable');
  }
  return bytes;
}
