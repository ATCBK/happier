import { Platform } from 'react-native';

export type BinaryUploadBody = Readonly<{ body: BodyInit; dispose: () => Promise<void> }>;

/** Common finite-frame request body for private byte transports. */
export async function createBinaryUploadBody(frame: AsyncIterable<Uint8Array>,
    options: Readonly<{ signal?: AbortSignal; assertCurrent?: () => void }> = {}): Promise<BinaryUploadBody> {
    const assertCurrent = () => {
        options.signal?.throwIfAborted();
        options.assertCurrent?.();
    };
    assertCurrent();
    if (Platform.OS !== 'web') {
        const { createNativeCacheFileSink } = await import('./nativeCacheFileSink');
        assertCurrent();
        const sink = await createNativeCacheFileSink({ directoryName: 'happier-uploads', fileName: 'binary-upload' });
        if (!sink.ok) throw new Error(sink.error);
        try {
            for await (const chunk of frame) {
                assertCurrent();
                await sink.writeBytes(chunk);
            }
            assertCurrent();
            await sink.close();
            // React Native's fetch accepts a file URI at its native networking boundary.
            // Keep file bytes out of the JS request-body heap; the caller owns disposal.
            const body = { uri: sink.fileUri } as unknown as BodyInit;
            return { body, dispose: async () => {
                try { await sink.cleanup(); }
                catch {
                    // The native cache owner reports cleanup failures. They must not
                    // rewrite an already observed Home result or its retry semantics.
                }
            } };
        } catch (error) {
            try { await sink.cleanup(); }
            catch (cleanupError) {
                throw Object.assign(new Error('Upload staging and cleanup failed'), { errors: [error, cleanupError] });
            }
            throw error;
        }
    }
    // Blob owns each finite chunk immediately, rather than retaining every leaf's
    // ArrayBuffer until the complete folder has been prepared. A Blob body also
    // preserves HTTP/1 upload support; browser request streams cannot guarantee it.
    const parts: Blob[] = [];
    for await (const chunk of frame) {
        assertCurrent();
        parts.push(new Blob([new Uint8Array(chunk)]));
    }
    assertCurrent();
    return { body: new Blob(parts), dispose: async () => {} };
}
