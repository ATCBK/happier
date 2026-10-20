import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { Parser, type DefaultTreeAdapterMap } from 'parse5';

/** Retain only the document head needed for CSP admission; the body follows stream backpressure. */
export function createCollectorHtmlStream(input: Readonly<{
    encoding: string;
    decoder: TextDecoder;
    maxBytes?: number;
    admitHead: (html: string, tree: DefaultTreeAdapterMap['document']) => string;
    write: (chunk: Uint8Array) => void | Promise<void>;
}>) {
    const source = new PassThrough();
    const decompressor = input.encoding === 'gzip' ? createGunzip() : input.encoding === 'deflate' ? createInflate()
        : input.encoding === 'br' ? createBrotliDecompress() : null;
    let parser: Parser<DefaultTreeAdapterMap> | null = new Parser({ sourceCodeLocationInfo: true });
    let headHtml = '';
    let bytes = 0;
    const text = async (value: string, final = false) => {
        if (parser) {
            headHtml += value;
            parser.tokenizer.write(value, final);
            // A missing/implicit head is handled by the same HTML parser as a complete document.
            // Once popped, later body chunks cannot change its CSP admission.
            if (!final && (!parser.headElement || parser.openElements.contains(parser.headElement))) return;
            value = input.admitHead(headHtml, parser.document);
            headHtml = '';
            parser = null;
        }
        if (value) await input.write(Buffer.from(value));
    };
    const consume = async (stream: AsyncIterable<Uint8Array>) => {
        for await (const chunk of stream) {
            bytes += chunk.byteLength;
            if (input.maxBytes !== undefined && bytes > input.maxBytes) throw new Error('response_body_too_large');
            await text(input.decoder.decode(chunk, { stream: true }));
        }
        await text(input.decoder.decode(), true);
    };
    const finished = decompressor ? pipeline(source, decompressor, consume) : pipeline(source, consume);
    // A stream may fail between writes. Keep the rejection observed until end/write reports it.
    void finished.catch(() => {});
    return {
        write: (chunk: Uint8Array) => new Promise<void>((resolve, reject) => source.write(chunk, (error) => error ? reject(error) : resolve())),
        async end() { source.end(); await finished; },
        destroy(error?: unknown) { source.destroy(error instanceof Error ? error : undefined); },
    };
}
