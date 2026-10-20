import { createAccountKvCipher } from '@happier-dev/protocol/crypto/accountKvCipher';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { parseSessionDataKeyValue, serializeSessionDataKeyValue } from '@happier-dev/protocol/crypto/sessionDataKeyBundleV0';
import { decodeBase64, encodeBase64 } from '@/encryption/base64';
import { AES256Encryption } from './encryptor';

/** Native/web AES implementation; Protocol owns the Account-KV selection rule. */
export function createUiAccountKvCipher(mode: 'plain' | 'e2ee', material: AccountScopedCryptoMaterial | null) {
    return createAccountKvCipher({ mode, material, dataKeyCipher: key => {
        const aes = new AES256Encryption(key);
        return {
            seal: async value => encodeBase64(await aes.encryptBytes(new TextEncoder().encode(serializeSessionDataKeyValue(value))), 'base64'),
            open: async encoded => {
                try {
                    const bytes = await aes.decryptBytes(decodeBase64(encoded, 'base64'));
                    return parseSessionDataKeyValue(new TextDecoder().decode(bytes));
                } catch { return { status: 'authentication_failed' }; }
            },
        };
    } });
}
