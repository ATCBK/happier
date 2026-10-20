// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createPdfCanvasViewer, type PdfCanvasDocument } from './pdfCanvasViewer';

describe('PDF canvas visibility and teardown', () => {
    it('allocates only intersecting canvases, cancels renders and clears them on leave/dispose', async () => {
        let observer!: IntersectionObserverCallback;
        let disconnected = false;
        const previous = globalThis.IntersectionObserver;
        // IntersectionObserver is the genuine browser boundary; rendering below it stays real.
        globalThis.IntersectionObserver = class {
            constructor(callback: IntersectionObserverCallback) { observer = callback; }
            observe() {} unobserve() {} takeRecords() { return []; }
            disconnect() { disconnected = true; }
            root = null; rootMargin = '150%'; thresholds = [0];
        };
        let cancelled = 0;
        // pdf.js is the library boundary. The proxy exposes only methods this engine consumes.
        const documentProxy = { numPages: 3, getPage: async () => ({
            getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
            render: () => ({ promise: new Promise<void>(() => {}), cancel: () => { cancelled++; } }),
        }) } as unknown as PdfCanvasDocument;
        const container = document.createElement('div');
        document.body.appendChild(container);
        try {
            const viewer = createPdfCanvasViewer({ container, document: documentProxy, scale: 1 });
            await viewer.ready;
            expect(container.querySelectorAll('canvas')).toHaveLength(0);
            const page = container.querySelector('[data-pdf-page="2"]')!;
            observer([{ target: page, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
            await Promise.resolve(); await Promise.resolve();
            expect(container.querySelectorAll('canvas')).toHaveLength(1);
            observer([{ target: page, isIntersecting: false } as IntersectionObserverEntry], {} as IntersectionObserver);
            expect(cancelled).toBe(1);
            expect(container.querySelectorAll('canvas')).toHaveLength(0);
            observer([{ target: page, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
            await Promise.resolve(); await Promise.resolve();
            viewer.dispose();
            expect(cancelled).toBe(2);
            expect(disconnected).toBe(true);
            expect(container.children).toHaveLength(0);
        } finally { globalThis.IntersectionObserver = previous; container.remove(); }
    });
});
