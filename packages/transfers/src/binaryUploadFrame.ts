/** Common wire mechanics: strict resource metadata is parsed by its resource owner. */
export function encodeBinaryUploadMetadataV1(metadata: unknown): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`${JSON.stringify(metadata)}\n`);
}

export function decodeBinaryUploadMetadataV1(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

export type BinaryUploadSegmentV1 = Readonly<{
    storedSizeBytes: number;
    bytes: Uint8Array | AsyncIterable<Uint8Array>;
}>;

/** Sequential consumption bounds framing memory to metadata and the current caller-owned chunk. */
export async function* iterateBinaryUploadFrameV1(metadata: unknown,
    segments: readonly BinaryUploadSegmentV1[]): AsyncGenerator<Uint8Array> {
    for (const segment of segments) {
        if (!Number.isSafeInteger(segment.storedSizeBytes) || segment.storedSizeBytes < 0) throw new Error('Invalid binary upload segment length');
    }
    yield encodeBinaryUploadMetadataV1(metadata);
    for (const segment of segments) {
        let remaining = segment.storedSizeBytes;
        const chunks = segment.bytes instanceof Uint8Array ? [segment.bytes] : segment.bytes;
        for await (const chunk of chunks) {
            if (!(chunk instanceof Uint8Array) || chunk.byteLength > remaining) throw new Error('Binary upload segment exceeds its declared length');
            remaining -= chunk.byteLength;
            if (chunk.byteLength > 0) yield chunk;
        }
        if (remaining !== 0) throw new Error('Binary upload segment is incomplete');
    }
}

export type BinaryUploadFrameReaderOptionsV1<T> = Readonly<{
    metadataMaxBytes: number;
    decodeMetadata: (bytes: Uint8Array) => T;
    onMetadata: (metadata: T) => Promise<readonly Readonly<{ storedSizeBytes: number }>[]>;
    onSegment: (segmentIndex: number, bytes: AsyncIterable<Uint8Array>) => Promise<void>;
}>;

/** Resource adapters preserve their existing HTTP response for the shared metadata boundary. */
export class BinaryUploadFrameErrorV1 extends Error {
    constructor(readonly code: 'metadata_too_large') {
        super('Binary upload metadata exceeds its transport boundary');
        this.name = 'BinaryUploadFrameErrorV1';
    }
}

/** One admitted request, one metadata line, then exactly the declared byte segments. */
export async function readBinaryUploadFrameV1<T>(stream: AsyncIterable<Uint8Array>,
    options: BinaryUploadFrameReaderOptionsV1<T>): Promise<T> {
    const iterator = stream[Symbol.asyncIterator]();
    let buffered: Uint8Array = new Uint8Array(0);
    let ended = false;
    const advance = async (): Promise<boolean> => {
        while (buffered.byteLength === 0 && !ended) {
            const next = await iterator.next();
            ended = next.done === true;
            if (!ended) {
                if (!(next.value instanceof Uint8Array)) throw new Error('Binary upload bytes unavailable');
                buffered = next.value;
            }
        }
        return buffered.byteLength > 0;
    };
    try {
        const prefix: Uint8Array[] = [];
        let metadataBytes = 0, separatorFound = false;
        while (await advance()) {
            const separator = buffered.indexOf(10);
            const part = separator < 0 ? buffered : buffered.subarray(0, separator);
            metadataBytes += part.byteLength;
            if (metadataBytes > options.metadataMaxBytes) throw new BinaryUploadFrameErrorV1('metadata_too_large');
            prefix.push(part);
            buffered = separator < 0 ? new Uint8Array(0) : buffered.subarray(separator + 1);
            if (separator >= 0) { separatorFound = true; break; }
        }
        if (!separatorFound) throw new Error('Binary upload metadata is incomplete');
        const metadataBuffer = new Uint8Array(metadataBytes);
        let offset = 0;
        for (const part of prefix) { metadataBuffer.set(part, offset); offset += part.byteLength; }
        prefix.length = 0;
        const metadata = options.decodeMetadata(metadataBuffer);
        const segments = await options.onMetadata(metadata);
        for (const segment of segments) {
            if (!Number.isSafeInteger(segment.storedSizeBytes) || segment.storedSizeBytes < 0) throw new Error('Invalid binary upload segment length');
        }
        for (const [index, segment] of segments.entries()) {
            let remaining = segment.storedSizeBytes;
            async function* bytes(): AsyncGenerator<Uint8Array> {
                while (remaining > 0) {
                    if (!await advance()) throw new Error('Binary upload segment is incomplete');
                    const count = Math.min(remaining, buffered.byteLength);
                    const chunk = buffered.subarray(0, count);
                    buffered = buffered.subarray(count);
                    remaining -= count;
                    yield chunk;
                }
            }
            await options.onSegment(index, bytes());
            if (remaining !== 0) throw new Error('Binary upload segment was not fully consumed');
        }
        if (await advance()) throw new Error('Binary upload contains extra bytes');
        return metadata;
    } finally {
        if (!ended && iterator.return) await iterator.return();
    }
}
