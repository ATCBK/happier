import { describe, expect, it } from 'vitest';
import { PDF_ZOOM_PRESETS, resolvePdfScale, resolvePdfCanvasSize, anchorPdfZoom } from './pdfZoom';

describe('PDF zoom', () => {
    it('resolves fit modes and presets while applying canvas bounds only to raster density', () => {
        const geometry = { pageWidth: 600, pageHeight: 800, viewportWidth: 1200, viewportHeight: 600 };
        expect(resolvePdfScale('fit-width', geometry)).toBe(1.6);
        expect(resolvePdfScale('fit-page', geometry)).toBe(0.75);
        expect(resolvePdfScale(0.1, geometry)).toBe(0.1);
        expect(resolvePdfScale(6, geometry)).toBe(6);
        expect(PDF_ZOOM_PRESETS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);
        const canvas = resolvePdfCanvasSize({ width: 3000, height: 6000, devicePixelRatio: 3 });
        expect(canvas.height).toBe(4096);
        expect(canvas.width).toBe(2048);
        expect(canvas.outputScale).toBeCloseTo(4096 / 6000);
    });
    it('preserves the pointer content point when changing absolute scale', () => {
        expect(anchorPdfZoom({ scrollLeft: 100, scrollTop: 300, pointerX: 50, pointerY: 75, previousScale: 1, nextScale: 2 }))
            .toEqual({ left: 250, top: 675 });
    });
});
