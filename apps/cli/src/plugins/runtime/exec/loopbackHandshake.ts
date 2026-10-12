import type { ExecLengthPrefixedByteOrderV1 } from './privateContract';
import { performance } from 'node:perf_hooks';
import { createPluginAcquisitionLifetime } from '../../distribution/acquisitionLifetime';

import {
    PluginExecClientError,
    createPluginExecClientAbortError,
    createPluginExecClientProtocolError,
} from './errors';

const LENGTH_PREFIX_BYTES = 4;
const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

type ByteReadableStream = NodeJS.ReadableStream & Readonly<{
    pause?: () => unknown;
    resume?: () => unknown;
    readableEnded?: boolean;
    destroyed?: boolean;
}>;

type ReadHandshakeFrameParams = Readonly<{
    stdout: NodeJS.ReadableStream;
    byteOrder: ExecLengthPrefixedByteOrderV1;
    maxFrameBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    readStderrPreview?: () => string | undefined;
}>;

function toBuffer(chunk: unknown): Buffer {
    if (Buffer.isBuffer(chunk)) {
        return chunk;
    }
    if (chunk instanceof Uint8Array) {
        return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    return Buffer.from(String(chunk));
}

function readFrameLength(buffer: Buffer, byteOrder: ExecLengthPrefixedByteOrderV1): number {
    return byteOrder === 'little-endian'
        ? buffer.readUInt32LE(0)
        : buffer.readUInt32BE(0);
}

function writeFrameLength(buffer: Buffer, byteOrder: ExecLengthPrefixedByteOrderV1, length: number): void {
    if (byteOrder === 'little-endian') {
        buffer.writeUInt32LE(length, 0);
        return;
    }
    buffer.writeUInt32BE(length, 0);
}

export function encodeLoopbackHandshakeFrame(
    frame: Uint8Array | string,
    byteOrder: ExecLengthPrefixedByteOrderV1,
): Buffer {
    const payload = typeof frame === 'string' ? Buffer.from(frame, 'utf8') : Buffer.from(frame);
    const prefix = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES);
    writeFrameLength(prefix, byteOrder, payload.byteLength);
    return Buffer.concat([prefix, payload]);
}

export async function readLoopbackHandshakeFrame(params: ReadHandshakeFrameParams): Promise<Uint8Array> {
    const stdout = params.stdout as ByteReadableStream;
    const maxFrameBytes = params.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    const stderrPreview = () => {
        const preview = params.readStderrPreview?.();
        return preview && preview.length > 0 ? preview : undefined;
    };

    if (params.signal?.aborted) {
        throw createPluginExecClientAbortError();
    }
    const lifetime = createPluginAcquisitionLifetime({
        signal: params.signal,
        ...(params.timeoutMs === undefined ? {} : {
            deadlineAtMonotonicMs: performance.now() + (
                Number.isFinite(params.timeoutMs) ? Math.max(0, params.timeoutMs) : 0
            ),
        }),
        errorLabel: 'Loopback WebSocket handshake',
    });
    const signal = lifetime.signal;

    return await new Promise<Uint8Array>((resolve, reject) => {
        let buffer = Buffer.alloc(0);
        let settled = false;

        function cleanup(): void {
            lifetime.dispose();
            stdout.off('data', onData);
            stdout.off('end', onEnd);
            stdout.off('close', onEnd);
            stdout.off('error', onError);
            signal?.removeEventListener('abort', onAbort);
        }

        function succeed(frame: Uint8Array): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(frame);
        }

        function fail(error: Error): void {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            reject(error);
        }

        function processBuffer(): void {
            if (buffer.byteLength < LENGTH_PREFIX_BYTES) {
                return;
            }
            const frameLength = readFrameLength(buffer, params.byteOrder);
            if (frameLength > maxFrameBytes) {
                fail(createPluginExecClientProtocolError('Loopback WebSocket handshake response exceeded the configured size limit', undefined, stderrPreview()));
                return;
            }
            const totalLength = LENGTH_PREFIX_BYTES + frameLength;
            if (buffer.byteLength < totalLength) {
                return;
            }
            succeed(Uint8Array.from(buffer.subarray(LENGTH_PREFIX_BYTES, totalLength)));
        }

        function onData(chunk: unknown): void {
            if (settled) {
                return;
            }
            buffer = Buffer.concat([buffer, toBuffer(chunk)]);
            processBuffer();
        }

        function onEnd(): void {
            fail(createPluginExecClientProtocolError('Loopback WebSocket handshake stdout ended before a complete response frame', undefined, stderrPreview()));
        }

        function onError(error: unknown): void {
            fail(createPluginExecClientProtocolError('Loopback WebSocket handshake stdout failed', error, stderrPreview()));
        }

        function onAbort(): void {
            fail(params.signal?.aborted ? createPluginExecClientAbortError() : new PluginExecClientError(
                'PLUGIN_EXEC_CLIENT_REQUEST_TIMEOUT',
                'Timed out waiting for loopback WebSocket handshake response',
                { stderrPreview: stderrPreview() },
            ));
        }

        stdout.on('data', onData);
        stdout.once('end', onEnd);
        stdout.once('close', onEnd);
        stdout.once('error', onError);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        else if (stdout.readableEnded || stdout.destroyed) onEnd();
        else {
            if (!settled) stdout.resume?.();
        }
    });
}
