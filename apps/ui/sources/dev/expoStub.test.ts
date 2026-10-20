import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import * as expo from './expoStub';

describe('expo vitest stub', () => {
    it('provides the optional native module bridge used by Expo packages', () => {
        expect(expo.requireOptionalNativeModule('ExpoHaptics')).toBeNull();
        expect(expo.default.requireOptionalNativeModule('ExpoHaptics')).toBeNull();
    });

    it('keeps Expo crypto importable without silently simulating native AES', () => {
        const crypto = expo.requireNativeModule<{
            EncryptionKey: new () => unknown;
            SealedData: new () => unknown;
        }>('ExpoCryptoAES');
        expect(() => new crypto.EncryptionKey()).toThrow(Error);
        expect(() => new crypto.SealedData()).toThrow(Error);
    });

    it('preserves binary slices through the native ExpoCrypto SDK digest', async () => {
        const { CryptoDigestAlgorithm, digest } = await import('expo-crypto');
        const input = new Uint8Array([255, 97, 98, 99, 0]).subarray(1, 4);
        const expected = new Uint8Array(createHash('sha256').update(new Uint8Array([97, 98, 99])).digest());
        const sdkDigest = await digest(CryptoDigestAlgorithm.SHA256, input);
        expect(new Uint8Array(sdkDigest)).toEqual(expected);
        const native = expo.requireNativeModule<{
            digest: (algorithm: string, output: Uint8Array, data: BufferSource) => void;
            digestAsync: (algorithm: string, data: BufferSource) => Promise<ArrayBuffer>;
        }>('ExpoCrypto');
        expect(new Uint8Array(await native.digestAsync('SHA-256', input))).toEqual(expected);
        const output = new Uint8Array(expected.length + 2).fill(255);
        native.digest('SHA-256', output.subarray(1, -1), input);
        expect(output).toEqual(new Uint8Array([255, ...expected, 255]));
    });

    it('propagates unsupported digest algorithms from native crypto', async () => {
        const native = expo.requireNativeModule<{
            digestAsync: (algorithm: string, data: BufferSource) => Promise<ArrayBuffer>;
        }>('ExpoCrypto');
        await expect(native.digestAsync('invalid-algorithm', new Uint8Array([1])))
            .rejects.toMatchObject({ name: 'NotSupportedError' });
    });
});
