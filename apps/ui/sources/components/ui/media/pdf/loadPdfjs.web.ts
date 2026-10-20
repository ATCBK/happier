import { resolvePdfjsAssetPaths } from './pdfjsAssets';
import { createPdfDocumentLoader } from './pdfDocumentLoader';
import type { PDFDocumentProxy } from 'pdfjs-dist';

let pending: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | undefined;

export function loadPdfjs() {
    if (!pending) {
        pending = import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
            pdfjs.GlobalWorkerOptions.workerSrc = resolvePdfjsAssetPaths(pdfjs.version).workerSrc;
            return pdfjs;
        }).catch((error: unknown) => { pending = undefined; throw error; });
    }
    return pending;
}

/** The only fetch here reads an already owned Blob URI; document bytes never reach a remote origin. */
export async function readPdfBlobBytes(uri: string, signal: AbortSignal): Promise<Uint8Array> {
    if (!uri.startsWith('blob:')) throw new Error('PDF preview requires an owned Blob URI');
    const response = await fetch(uri, { signal });
    if (!response.ok) throw new Error(`PDF preview read failed (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
}

export async function createWebPdfDocumentLoader(setDocument: (document: PDFDocumentProxy | null, signal?: AbortSignal) => void) {
    const pdfjs = await loadPdfjs();
    const { workerSrc: _workerSrc, ...assets } = resolvePdfjsAssetPaths(pdfjs.version);
    return createPdfDocumentLoader({ setDocument, getDocument: bytes => pdfjs.getDocument({ data: bytes, ...assets, cMapPacked: true, isEvalSupported: false }) });
}
