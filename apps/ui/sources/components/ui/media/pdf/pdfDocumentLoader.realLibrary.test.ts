import { describe, expect, it, vi } from 'vitest';
import type { PDFDocumentLoadingTask } from 'pdfjs-dist';
import { createPdfDocumentLoader } from './pdfDocumentLoader';

function pdfBytes() {
    const stream = 'BT /F1 18 Tf 72 720 Td (retry) Tj ET';
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = '%PDF-1.7\n';
    const offsets: number[] = [];
    for (const [index, object] of objects.entries()) {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
    pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return new TextEncoder().encode(pdf);
}

describe('installed legacy pdf.js document lifetime', () => {
    it('replaces, clears and disposes real documents through their owning loading tasks', async () => {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const tasks: PDFDocumentLoadingTask[] = [];
        const events: string[] = [];
        const loader = createPdfDocumentLoader({
            getDocument: bytes => {
                const task = pdfjs.getDocument({ data: bytes });
                const destroy = task.destroy.bind(task);
                // Observe the real library lifecycle; retain its actual worker/transport cleanup.
                vi.spyOn(task, 'destroy').mockImplementation(async () => { events.push('destroy'); await destroy(); });
                tasks.push(task);
                return task;
            },
            setDocument: (document, signal) => {
                if (document) signal!.addEventListener('abort', () => events.push('abort'));
                else events.push('detach');
            },
        });
        try {
            const first = await loader.load(pdfBytes());
            expect(first.status).toBe('ready');
            if (first.status !== 'ready') throw new Error('Expected a parsed PDF');
            expect(first.document.loadingTask).toBe(tasks[0]);
            events.length = 0;
            const replacement = await loader.load(pdfBytes());
            expect(events.slice(0, 3)).toEqual(['detach', 'abort', 'destroy']);
            expect(tasks[0]!.destroyed).toBe(true);
            expect(replacement.status).toBe('ready');
            if (replacement.status !== 'ready') throw new Error('Expected a replacement PDF');
            const viewport = (await replacement.document.getPage(1)).getViewport({ scale: 1 });
            expect({ width: viewport.width, height: viewport.height }).toEqual({ width: 612, height: 792 });
            await loader.clear();
            expect(tasks[1]!.destroyed).toBe(true);
            expect((await loader.load(pdfBytes())).status).toBe('ready');
            await loader.dispose();
            expect(tasks.every(task => task.destroyed)).toBe(true);
        } finally {
            // A RED must not leave the real library's worker alive.
            await Promise.all(tasks.map(task => task.destroy()));
        }
    });
});
