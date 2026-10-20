import { describe, expect, it } from 'vitest';
import { createPdfDocumentLoader, type PdfDocumentHandle, type PdfLoadingTask } from './pdfDocumentLoader';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('PDF document lifetime', () => {
    it('observes an immediate parser rejection while the previous document is still destroying', async () => {
        const oldDestroy = deferred<void>();
        let count = 0;
        const loader = createPdfDocumentLoader({ getDocument: () => count++ === 0
            ? { promise: Promise.resolve({ numPages: 1 }), destroy: () => oldDestroy.promise }
            : { promise: Promise.reject(new Error('InvalidPDFException')), destroy: async () => {} }, setDocument: () => {} });
        await loader.load(new TextEncoder().encode('%PDF-1.7'));
        const pending = loader.load(new TextEncoder().encode('%PDF-broken'));
        // A parser rejection can occur before asynchronous worker destruction completes.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        oldDestroy.resolve();
        await expect(pending).resolves.toMatchObject({ status: 'error', reason: 'failed' });
        await loader.dispose();
    });
    it('accepts a PDF header inside the canonical classifier preamble window', async () => {
        const document = { numPages: 1 };
        const loader = createPdfDocumentLoader({ getDocument: () => ({ promise: Promise.resolve(document), destroy: async () => {} }), setDocument: () => {} });
        expect(await loader.load(new TextEncoder().encode('\uFEFFgenerated preamble\n%PDF-1.7'))).toEqual({ status: 'ready', document });
        await loader.dispose();
    });
    it('destroys superseded tasks and never attaches an old A after A → B → A', async () => {
        const pending: ReturnType<typeof deferred<PdfDocumentHandle>>[] = [];
        const destroyed: number[] = [];
        const shown: (PdfDocumentHandle | null)[] = [];
        const loader = createPdfDocumentLoader({
            // pdf.js is the external library boundary; task resolution deliberately races cancellation.
            getDocument: () => {
                const id = pending.length;
                const result = deferred<PdfDocumentHandle>(); pending.push(result);
                return { promise: result.promise, destroy: async () => { destroyed.push(id); } } satisfies PdfLoadingTask;
            },
            setDocument: (document) => { shown.push(document); },
        });
        const bytes = new TextEncoder().encode('%PDF-1.7');
        const first = loader.load(bytes);
        const second = loader.load(bytes);
        const third = loader.load(bytes);
        const documents = [0, 1, 2].map(() => ({ numPages: 1 }));
        pending[2]!.resolve(documents[2]!); await third;
        pending[0]!.resolve(documents[0]!); expect(await first).toEqual({ status: 'cancelled' });
        pending[1]!.resolve(documents[1]!); expect(await second).toEqual({ status: 'cancelled' });
        expect(shown.filter(Boolean)).toEqual([documents[2]]);
        expect(destroyed).toEqual([0, 1]);
        await loader.dispose();
        expect(destroyed).toEqual([0, 1, 2]);
        expect(shown.at(-1)).toBeNull();
    });

    it('detaches renders, aborts viewer listeners, then destroys the shown document loading task', async () => {
        const events: string[] = [];
        const document = { numPages: 2 };
        const loader = createPdfDocumentLoader({ getDocument: () => ({ promise: Promise.resolve(document), destroy: async () => { events.push('destroy'); } }),
            setDocument: (next, signal) => {
                if (next) signal!.addEventListener('abort', () => events.push('abort'));
                else events.push('detach');
            } });
        await loader.load(new TextEncoder().encode('%PDF-1.7'));
        events.length = 0;
        await loader.dispose();
        expect(events).toEqual(['detach', 'abort', 'destroy']);
    });

    it('rejects non-PDF bytes before library parsing and clears old pages on failure', async () => {
        let calls = 0;
        const shown: unknown[] = [];
        const loader = createPdfDocumentLoader({ getDocument: () => { calls++; throw new Error('parser'); }, setDocument: value => shown.push(value) });
        await expect(loader.load(new TextEncoder().encode('<html>not a PDF'))).resolves.toMatchObject({ status: 'error', reason: 'invalid' });
        expect(calls).toBe(0);
        expect(shown.at(-1)).toBeNull();
    });
});
