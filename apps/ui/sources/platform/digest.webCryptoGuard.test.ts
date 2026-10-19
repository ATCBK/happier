import { afterEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = typeof globalThis & {
    window?: unknown;
};

const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');

function setGlobalWindow(value: GlobalWithWindow['window']): void {
    Object.defineProperty(globalThis, 'window', {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}

function setGlobalCrypto(value: unknown): void {
    Object.defineProperty(globalThis, 'crypto', {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
    });
}

afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    if (originalWindowDescriptor) {
        Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).window;
    }

    if (originalCryptoDescriptor) {
        Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor);
    } else {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete (globalThis as any).crypto;
    }
});

describe('platform/digest (web guard)', () => {
    it('passes ordinary web byte views directly to the platform snapshot without another full-size allocation', async () => {
        setGlobalCrypto({ subtle: { digest() {} } });
        vi.doMock('react-native', async () => {
            const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
            return createReactNativeWebMock();
        });
        const expoDigest = vi.fn(async (_algorithm: unknown, data: Uint8Array) => {
            expect([...data]).toEqual([2, 3]);
            return new ArrayBuffer(32);
        });
        vi.doMock('expo-crypto', () => ({ CryptoDigestAlgorithm: { SHA256: 'SHA256', SHA512: 'SHA512' }, digest: expoDigest }));
        const { digest } = await import('./digest');
        const bytes = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
        await digest('SHA-256', bytes);
        expect(expoDigest.mock.calls[0]![1].buffer).toBe(bytes.buffer);
        const shared = new Uint8Array(new SharedArrayBuffer(4));
        shared.set([1, 2, 3, 4]);
        await digest('SHA-512', shared.subarray(1, 3));
        expect(expoDigest.mock.calls[1]![1].buffer).toBeInstanceOf(ArrayBuffer);
        expect(expoDigest.mock.calls[1]![1].buffer).not.toBe(shared.buffer);
    });
    it('throws a helpful error when WebCrypto SubtleCrypto is unavailable (e.g. http://LAN-IP)', async () => {
        // Use a minimal window-like shape; cast is intentional for test-only DOM fixtures.
        setGlobalWindow({ location: { origin: 'http://192.168.1.50:8081' }, isSecureContext: false } as any);
        setGlobalCrypto({});

        vi.doMock('react-native', () => ({
            Platform: { OS: 'web' },
        }));

        const expoDigest = vi.fn().mockRejectedValue(
            new TypeError("undefined is not an object (evaluating 'getCrypto().subtle.digest')")
        );
        vi.doMock('expo-crypto', () => ({
            CryptoDigestAlgorithm: { SHA256: 'SHA256', SHA512: 'SHA512' },
            digest: expoDigest,
        }));

        const { digest } = await import('./digest');

        await expect(digest('SHA-256', new Uint8Array([1, 2, 3]))).rejects.toThrow(/https|localhost|secure/i);
    });

    it('does not block on native platforms even if a window global exists', async () => {
        // In React Native dev builds, a `window` global may exist, but WebCrypto is not required.
        setGlobalWindow({ location: { origin: 'http://192.168.1.50:8081' } } as any);
        setGlobalCrypto({});

        vi.doMock('react-native', () => ({
            Platform: { OS: 'ios' },
        }));

        const expoDigest = vi.fn().mockResolvedValue(new ArrayBuffer(0));
        vi.doMock('expo-crypto', () => ({
            CryptoDigestAlgorithm: { SHA256: 'SHA256', SHA512: 'SHA512' },
            digest: expoDigest,
        }));

        const { digest } = await import('./digest');

        const bytes = new Uint8Array([1, 2, 3]);
        await expect(digest('SHA-256', bytes)).resolves.toEqual(new Uint8Array(0));
        expect(expoDigest).toHaveBeenCalledTimes(1);
        expect(expoDigest.mock.calls[0]![1].buffer).not.toBe(bytes.buffer);
    });
});
