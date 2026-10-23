import { describe, expect, it } from 'vitest';
import { decodeBinaryUploadMetadataV1, iterateBinaryUploadFrameV1, readBinaryUploadFrameV1 } from './binaryUploadFrame.js';
import { encodeArtifactUploadFrameV1, iterateArtifactUploadFrameV1, decodeArtifactUploadMetadataV1 } from './artifactUploadFrame.js';

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    const output = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
}

describe('private binary upload framing', () => {
    it('admits metadata before yielding exact ordered incoming segments including empty files', async () => {
        const received: number[][] = [], admitted: string[] = [];
        async function* incoming() {
            yield new TextEncoder().encode('{"operation":"post"');
            yield new TextEncoder().encode('}\n');
            expect(admitted).toEqual(['post']);
            yield Uint8Array.of(1, 2, 3);
        }
        const metadata = await readBinaryUploadFrameV1(incoming(), { metadataMaxBytes: 100,
            decodeMetadata: bytes => JSON.parse(new TextDecoder().decode(bytes)) as { operation: string },
            onMetadata: async value => { admitted.push(value.operation); return [{ storedSizeBytes: 2 }, { storedSizeBytes: 0 }, { storedSizeBytes: 1 }]; },
            onSegment: async (index, bytes) => { received[index] = [...await collect(bytes)]; },
        });
        expect(metadata).toEqual({ operation: 'post' });
        expect(received).toEqual([[1, 2], [], [3]]);
    });

    it('rejects incomplete, extra and unconsumed incoming bytes and oversized metadata', async () => {
        for (const [payload, length] of [[Uint8Array.of(1), 2], [Uint8Array.of(1, 2), 1]] as const) {
            async function* incoming() { yield new TextEncoder().encode('{}\n'); yield payload; }
            await expect(readBinaryUploadFrameV1(incoming(), { metadataMaxBytes: 2,
                decodeMetadata: decodeBinaryUploadMetadataV1, onMetadata: async () => [{ storedSizeBytes: length }],
                onSegment: async (_index, bytes) => { await collect(bytes); },
            })).rejects.toThrow();
        }
        async function* incoming() { yield new TextEncoder().encode('{}\n'); yield Uint8Array.of(1); }
        await expect(readBinaryUploadFrameV1(incoming(), { metadataMaxBytes: 2,
            decodeMetadata: decodeBinaryUploadMetadataV1, onMetadata: async () => [{ storedSizeBytes: 1 }], onSegment: async () => {},
        })).rejects.toThrow();
        await expect(readBinaryUploadFrameV1(incoming(), { metadataMaxBytes: 1,
            decodeMetadata: decodeBinaryUploadMetadataV1, onMetadata: async () => [], onSegment: async () => {},
        })).rejects.toMatchObject({ code: 'metadata_too_large' });
    });

    it('preserves declared ordered segments without eager acquisition or concatenating whole files', async () => {
        const acquired: number[] = [];
        async function* bytes(id: number, values: number[]) { acquired.push(id); for (const value of values) yield Uint8Array.of(value); }
        const metadata = { operation: 'test', attachments: [{ storedSizeBytes: 2 }, { storedSizeBytes: 0 }, { storedSizeBytes: 1 }] };
        const stream = iterateBinaryUploadFrameV1(metadata, [
            { storedSizeBytes: 2, bytes: bytes(1, [0, 255]) },
            { storedSizeBytes: 0, bytes: bytes(2, []) },
            { storedSizeBytes: 1, bytes: bytes(3, [10]) },
        ]);
        const prefix = await stream.next();
        expect(acquired).toEqual([]);
        expect(prefix.done).toBe(false);
        expect(decodeBinaryUploadMetadataV1(prefix.value!.subarray(0, prefix.value!.byteLength - 1))).toEqual(metadata);
        expect(await collect(stream)).toEqual(Uint8Array.of(0, 255, 10));
        expect(acquired).toEqual([1, 2, 3]);
    });

    it('rejects incomplete and extra bytes before a later segment can be acquired', async () => {
        let acquired = false;
        async function* later() { acquired = true; yield Uint8Array.of(7); }
        for (const bytes of [new Uint8Array(0), Uint8Array.of(1, 2)]) {
            await expect(collect(iterateBinaryUploadFrameV1({}, [
                { storedSizeBytes: 1, bytes }, { storedSizeBytes: 1, bytes: later() },
            ]))).rejects.toThrow();
            expect(acquired).toBe(false);
        }
    });

    it('closes an active source on cancellation and never acquires a later file', async () => {
        let closed = false, acquiredLater = false;
        async function* first() { try { yield Uint8Array.of(1); yield Uint8Array.of(2); } finally { closed = true; } }
        async function* later() { acquiredLater = true; yield Uint8Array.of(3); }
        const stream = iterateBinaryUploadFrameV1({}, [{ storedSizeBytes: 2, bytes: first() }, { storedSizeBytes: 1, bytes: later() }]);
        await stream.next();
        await stream.next();
        await stream.return(undefined);
        expect(closed).toBe(true);
        expect(acquiredLater).toBe(false);
    });

    it('keeps Artifact single-frame and streamed encoding on the same metadata-line and binary representation', async () => {
        const destination = { kind: 'encryption-conversion' as const,
            artifactId: '00000000-0000-4000-8000-000000000001', blobId: '00000000-0000-4000-8000-000000000002' };
        const frame = encodeArtifactUploadFrameV1(destination, { t: 'plain', v: 'AP8K' });
        const separator = frame.indexOf(10);
        expect(decodeArtifactUploadMetadataV1(frame.subarray(0, separator))).toEqual({ ...destination, t: 'plain', sizeBytes: 3 });
        expect(frame.subarray(separator + 1)).toEqual(Uint8Array.of(0, 255, 10));
        expect(await collect(iterateArtifactUploadFrameV1(destination, { t: 'plain', v: 'AP8K' }))).toEqual(frame);
    });
});
