// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { parsePdfWebViewMessage, type PdfWebViewMessage } from './pdfNativeBridge';
import { transferPdfToWebView } from './pdfNativeTransfer';

const boundary = vi.hoisted(() => ({ protected: false, destroyed: 0 }));
// The pdf.js library is the genuine boundary. Bridge, document ownership, canvas
// engine, Find extraction and the strict host parser below are the real owners.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
    GlobalWorkerOptions: { workerSrc: '' },
    getDocument: () => ({
        promise: boundary.protected ? Promise.reject(Object.assign(new Error('password'), { name: 'PasswordException' })) : Promise.resolve({
            numPages: 3, destroy: async () => { boundary.destroyed++; },
            getPage: async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
                getTextContent: async () => ({ items: [{ str: 'retry retry retry' }] }),
                render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
            }),
        }), destroy: async () => {},
    }),
    TextLayer: class {
        textDivs: HTMLElement[] = [];
        constructor(private input: { container: HTMLElement; textContentSource: { items: { str: string }[] } }) {}
        async render() { for (const item of this.input.textContentSource.items) { const span = document.createElement('span'); span.textContent = item.str; this.textDivs.push(span); this.input.container.append(span); } }
        cancel() {}
    },
}));

describe('native PDF composed bridge', () => {
    it('assembles slices, counts all pages, clears a replaced document and destroys its worker ownership', async () => {
        vi.stubGlobal('__PDFJS_WORKER_SOURCE__', 'worker source');
        const create = URL.createObjectURL; const revoke = URL.revokeObjectURL;
        URL.createObjectURL = () => 'blob:pdf-test-worker';
        const revoked: string[] = []; URL.revokeObjectURL = value => { revoked.push(value); };
        const previous = globalThis.IntersectionObserver;
        let intersections!: IntersectionObserverCallback;
        let disconnected = false;
        globalThis.IntersectionObserver = class {
            constructor(callback: IntersectionObserverCallback) { intersections = callback; }
            observe() {} unobserve() {} takeRecords() { return []; } disconnect() { disconnected = true; }
            root = null; rootMargin = '150%'; thresholds = [0];
        };
        const messages: PdfWebViewMessage[] = [];
        window.ReactNativeWebView = { postMessage: raw => { const parsed = parsePdfWebViewMessage(raw); if (!parsed) throw new Error('Invalid PDF metadata'); messages.push(parsed); } };
        const container = document.createElement('div'); container.id = 'pdf-pages'; document.body.append(container);
        try {
            await import('./pdfWebViewEntry');
            const bytes = new TextEncoder().encode('%PDF-1.7');
            await transferPdfToWebView({ sliceBytes: 3, signal: new AbortController().signal,
                source: { getSize: async () => bytes.length, readBase64: async (offset, length) => btoa(String.fromCharCode(...bytes.slice(offset, offset + length))) },
                injectJavaScript: script => { Function('window', script)(window); },
            });
            await vi.waitFor(() => expect(messages).toContainEqual({ type: 'ready', pages: 3 }));
            expect(container.querySelectorAll('canvas')).toHaveLength(0);
            window.__pdfFind('retry');
            await vi.waitFor(() => expect(messages).toContainEqual({ type: 'find', current: 1, total: 9, complete: true }));
            window.__pdfStep(1); window.__pdfStep(1);
            expect(messages.at(-1)).toEqual({ type: 'find', current: 3, total: 9, complete: true });
            const page = container.querySelector('[data-pdf-page="1"]')!;
            intersections([{ target: page, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
            await vi.waitFor(() => expect(container.querySelectorAll('canvas')).toHaveLength(1));
            boundary.protected = true;
            window.__pdfBegin(bytes.length); window.__pdfAppend(btoa(String.fromCharCode(...bytes))); await window.__pdfOpen();
            expect(messages.at(-1)).toEqual({ type: 'state', state: 'protected' });
            expect(container.querySelectorAll('canvas')).toHaveLength(0);
            expect(boundary.destroyed).toBe(1);
            await window.__pdfDispose();
            expect(disconnected).toBe(true);
            expect(revoked).toEqual(['blob:pdf-test-worker']);
        } finally {
            await window.__pdfDispose?.(); container.remove(); delete window.ReactNativeWebView;
            globalThis.IntersectionObserver = previous; URL.createObjectURL = create; URL.revokeObjectURL = revoke; vi.unstubAllGlobals();
        }
    });
});
