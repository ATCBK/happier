import type { FileHandle } from 'node:fs/promises';

/** A procfs OS file descriptor fixture; the census and its chunked reader stay real. */
export function procfsFileHandle(contents: string | Buffer, beforeRead?: () => Promise<void>): FileHandle {
    const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
    let cursor = 0;
    const handle = {
        async read<T extends NodeJS.ArrayBufferView>(buffer: T, offset: number, length: number, position: number | null) {
            if (beforeRead) await beforeRead();
            const start = position ?? cursor;
            const target = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
            const bytesRead = bytes.copy(target, offset, start, start + length);
            if (position === null) cursor += bytesRead;
            return { bytesRead, buffer };
        },
        async close() {},
    };
    // Genuine FileHandle boundary fixture implements only the descriptor operations under test.
    return handle as FileHandle;
}
