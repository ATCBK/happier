import type { LocalServicePreviewHttpResponseHeaders, LocalServicePreviewHttpResponseSink } from '@/app/local/services/preview/httpAdapter';
import { writeLocalServicePreviewDownstream } from '@/app/local/services/preview/downstream';
import { logUnexpectedRequestError } from '@/app/api/utils/logUnexpectedRequestError';

export type LocalServicePreviewHttpReply = {
    request?: { id: string };
    hijack?: () => unknown;
    code?: (statusCode: number) => LocalServicePreviewHttpReply;
    header?: (name: string, value: string | readonly string[]) => LocalServicePreviewHttpReply;
    send?: (payload?: unknown) => unknown;
    raw?: {
        writeHead?: (statusCode: number, statusMessage: string, headers: Record<string, string | readonly string[]>) => void;
        write?: (chunk: Uint8Array) => unknown;
        end?: () => void;
        destroy?: (error?: unknown) => void;
        once?: (event: 'close' | 'drain' | 'error', listener: () => void) => unknown;
        on?: (event: 'close' | 'drain' | 'error', listener: () => void) => unknown;
        off?: (event: 'close' | 'drain' | 'error', listener: () => void) => unknown;
        removeListener?: (event: 'close' | 'drain' | 'error', listener: () => void) => unknown;
        destroyed?: boolean;
        writableEnded?: boolean;
    };
};

/** Raw preview responses own their lifecycle once headers begin, including failed cleanup. */
export async function sendLocalServicePreviewHttpResponse<T>(
    reply: LocalServicePreviewHttpReply,
    forward: (response: LocalServicePreviewHttpResponseSink) => Promise<T>,
    transformHeaders?: (headers: LocalServicePreviewHttpResponseHeaders) => LocalServicePreviewHttpResponseHeaders,
): Promise<T | undefined> {
    let started = false;
    const response: LocalServicePreviewHttpResponseSink = {
        writeHead(statusCode, statusMessage, headers) {
            const responseHeaders = transformHeaders?.(headers) ?? headers;
            if (reply.raw?.writeHead) {
                // Fastify must not serialize a result or error over this streamed response.
                reply.hijack?.();
                started = true;
                reply.raw.writeHead(statusCode, statusMessage, { ...responseHeaders });
                return;
            }
            reply.code?.(statusCode);
            for (const [name, value] of Object.entries(responseHeaders)) reply.header?.(name, value);
        },
        write(chunk) { return writeLocalServicePreviewDownstream(reply.raw, chunk); },
        end() {
            if (reply.raw?.end) reply.raw.end();
            else reply.send?.();
        },
        destroy(error) { reply.raw?.destroy?.(error); },
    };
    try {
        return await forward(response);
    } catch (error) {
        if (!started) throw error;
        logUnexpectedRequestError(error, { module: 'fastify-error', httpRequestId: reply.request?.id ?? 'unknown' });
        // The error is logged above; closing without another error avoids an unowned error event.
        reply.raw?.destroy?.();
        return undefined;
    }
}
