import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

/** Procfs reports size zero. readFile's unknown-size 64 KiB allocation is wasteful
 * for every stat/status/cgroup; read into one small buffer until EOF instead.
 * This is a transfer granularity, not a file-size limit (argv/environ can be large).
 */
export async function readLinuxProcFile(path: string, encoding?: 'utf8'): Promise<string | Buffer> {
    const handle = await open(path, 'r');
    try {
        // Half the standard Node buffer pool: one buffer reused for this open file.
        const buffer = Buffer.allocUnsafe(4 * 1024);
        const decoder = encoding ? new StringDecoder(encoding) : undefined;
        const text: string[] = [];
        const chunks: Buffer[] = [];
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
            if (bytesRead === 0) break;
            const chunk = buffer.subarray(0, bytesRead);
            if (decoder) text.push(decoder.write(chunk));
            else chunks.push(Buffer.from(chunk));
        }
        return decoder ? text.join('') + decoder.end() : Buffer.concat(chunks);
    } finally { await handle.close(); }
}
