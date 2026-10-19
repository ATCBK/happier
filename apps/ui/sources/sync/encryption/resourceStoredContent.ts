import type { SessionStoredContentContext } from '@happier-dev/sync-client';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { AES256Encryption } from './encryptor';
import type { ResourceDataKey } from './resourceDataKey';

/** Reuse the canonical explicit envelope codec with this resource's own cipher. */
export function resourceStoredContentContext(key: ResourceDataKey | null): SessionStoredContentContext | null {
    if (!key) return null;
    if (key.mode === 'plain') return { mode: 'plain' };
    const cipher = new AES256Encryption(key.dataKey);
    return { mode: 'e2ee', encryption: {
        encryptRaw: async value => encodeBase64((await cipher.encrypt([value]))[0]!, 'base64'),
        decryptRaw: async value => (await cipher.decrypt([decodeBase64(value, 'base64')]))[0] ?? null,
    } };
}
