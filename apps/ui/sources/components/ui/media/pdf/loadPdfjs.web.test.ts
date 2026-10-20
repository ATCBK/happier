import { describe, expect, it, vi } from 'vitest';
import { resolvePdfjsAssetPaths } from './pdfjsAssets';
import { loadPdfjs, createWebPdfDocumentLoader, readPdfBlobBytes } from './loadPdfjs.web';

const boundary = vi.hoisted(() => ({
    version: '6.4.299', worker: { workerSrc: '' }, getDocument: vi.fn((_options: Readonly<Record<string, unknown>>) => ({
        promise: Promise.resolve({ numPages: 1, destroy: async () => {} }), destroy: async () => {},
    })),
}));
// pdf.js is the actual third-party boundary. The loader, admission and lifetime remain real.
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ version: boundary.version, GlobalWorkerOptions: boundary.worker, getDocument: boundary.getDocument }));

describe('legacy PDF library loading', () => {
    it('uses the library version for every vendored asset and sends bytes rather than a document URL', async () => {
        const library = await loadPdfjs();
        const assets = resolvePdfjsAssetPaths(library.version);
        expect(boundary.worker.workerSrc).toBe(`/pdfjs/${library.version}/pdf.worker.min.js`);
        for (const path of Object.values(assets)) expect(path.startsWith(`/pdfjs/${library.version}/`)).toBe(true);
        const loader = await createWebPdfDocumentLoader(() => {});
        await loader.load(new TextEncoder().encode('%PDF-1.7'));
        const options = boundary.getDocument.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
        expect(options).toMatchObject({ cMapUrl: assets.cMapUrl, standardFontDataUrl: assets.standardFontDataUrl,
            wasmUrl: assets.wasmUrl, iccUrl: assets.iccUrl, isEvalSupported: false, data: new TextEncoder().encode('%PDF-1.7') });
        expect(options).not.toHaveProperty('url');
        await loader.dispose();
    });
    it('rejects remote PDF requests at the byte reader boundary', async () => {
        await expect(readPdfBlobBytes('https://example.org/private.pdf', new AbortController().signal)).rejects.toThrow('Blob');
    });
});
