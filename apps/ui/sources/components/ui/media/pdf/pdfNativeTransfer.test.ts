import { describe, expect, it } from 'vitest';
import { createPdfSliceAssembler } from './pdfNativeBridge';
import { transferPdfToWebView } from './pdfNativeTransfer';

describe('native PDF slice producer → page consumer', () => {
    it('reads bounded raw slices and produces exactly the input bytes', async () => {
        const original = new Uint8Array([37, 80, 68, 70, 45, 0, 255, 12]);
        let assembler: ReturnType<typeof createPdfSliceAssembler>;
        let result: Uint8Array | null = null;
        const sizes: number[] = [];
        const page = {
            __pdfBegin: (size: number) => { assembler = createPdfSliceAssembler(size); },
            __pdfAppend: (slice: string) => assembler.append(slice),
            __pdfOpen: () => { result = assembler.finish(); },
        };
        await transferPdfToWebView({ sliceBytes: 3, signal: new AbortController().signal,
            source: { getSize: async () => original.length, readBase64: async (offset, length) => {
                sizes.push(length); return btoa(String.fromCharCode(...original.slice(offset, offset + length)));
            } },
            // The native JS-injection boundary executes the real page assembler.
            injectJavaScript: script => { Function('window', script)(page); },
        });
        expect(result).toEqual(original);
        expect(sizes).toEqual([3, 3, 2]);
    });
    it('does not open partial bytes when the file changes or cancellation wins an awaited read', async () => {
        for (const cancel of [false, true]) {
            const controller = new AbortController();
            const scripts: string[] = [];
            let reads = 0;
            await expect(transferPdfToWebView({ sliceBytes: 3, signal: controller.signal,
                source: { getSize: async () => reads ? 4 : 3, readBase64: async () => {
                    reads++; if (cancel) controller.abort(); return 'AQID';
                } }, injectJavaScript: script => { scripts.push(script); },
            })).rejects.toThrow();
            expect(scripts.some(script => script.includes('__pdfOpen'))).toBe(false);
            expect(scripts.some(script => script.includes('__pdfAppend'))).toBe(false);
        }
    });
});
