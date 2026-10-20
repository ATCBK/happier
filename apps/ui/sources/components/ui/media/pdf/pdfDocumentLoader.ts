import { resolveFileViewerKind } from '@/scm/utils/filePresentation';

export interface PdfDocumentHandle { readonly numPages: number; destroy(): Promise<void>; }
export interface PdfLoadingTask<T extends PdfDocumentHandle = PdfDocumentHandle> { readonly promise: Promise<T>; destroy(): Promise<void>; }
export type PdfLoadResult<T> = Readonly<{ status: 'ready'; document: T }> | Readonly<{ status: 'cancelled' }>
    | Readonly<{ status: 'error'; reason: 'protected' | 'invalid' | 'failed'; error?: unknown }>;

export function createPdfDocumentLoader<T extends PdfDocumentHandle>(options: Readonly<{ getDocument(bytes: Uint8Array): PdfLoadingTask<T>; setDocument(document: T | null, signal?: AbortSignal): void }>) {
    let current: { task: PdfLoadingTask<T> | null; document: T | null; listeners: AbortController } | null = null;
    let disposed = false;
    const detach = () => {
        const previous = current; current = null;
        options.setDocument(null);
        previous?.listeners.abort();
        return previous?.document ? previous.document.destroy() : previous?.task?.destroy() ?? Promise.resolve();
    };
    return {
        async load(bytes: Uint8Array): Promise<PdfLoadResult<T>> {
            if (disposed) return { status: 'cancelled' };
            const cleanup = detach();
            const entry = { task: null as PdfLoadingTask<T> | null, document: null as T | null, listeners: new AbortController() };
            current = entry;
            // Start synchronously: a pending task is owned even if a second load arrives immediately.
            try {
                if (resolveFileViewerKind({ path: 'preview.pdf', head: bytes }).kind !== 'pdf') {
                    await cleanup;
                    if (current !== entry || disposed) return { status: 'cancelled' };
                    current = null;
                    return { status: 'error', reason: 'invalid' };
                }
                entry.task = options.getDocument(bytes);
                // Observe parser failure immediately, even while an old worker is destroying.
                const [document] = await Promise.all([entry.task.promise, cleanup]);
                if (current !== entry || disposed) { await document.destroy(); return { status: 'cancelled' }; }
                entry.document = document;
                options.setDocument(document, entry.listeners.signal);
                return { status: 'ready', document };
            } catch (error) {
                if (current !== entry || disposed) return { status: 'cancelled' };
                await detach();
                return { status: 'error', reason: error instanceof Error && error.name === 'PasswordException' ? 'protected' : 'failed', error };
            }
        },
        clear: detach,
        async dispose() { disposed = true; await detach(); },
    };
}
