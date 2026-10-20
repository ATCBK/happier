export const PDF_ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export type PdfZoom = 'fit-width' | 'fit-page' | number;
type Geometry = Readonly<{ pageWidth: number; pageHeight: number; viewportWidth: number; viewportHeight: number }>;

// Approved P2 canvas resource bounds: reduce raster density, never the document's layout size.
export const PDF_CANVAS_MAX_SIDE = 4096;
export const PDF_CANVAS_MAX_DPR = 2;
export const PDF_FIT_WIDTH_MAX = 960;

export function resolvePdfScale(zoom: PdfZoom, geometry: Geometry): number {
    if (typeof zoom === 'number') return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
    const widthScale = Math.min(PDF_FIT_WIDTH_MAX, geometry.viewportWidth) / geometry.pageWidth;
    return zoom === 'fit-width' ? widthScale : Math.min(widthScale, geometry.viewportHeight / geometry.pageHeight);
}

export function resolvePdfCanvasSize(input: Readonly<{ width: number; height: number; devicePixelRatio: number }>) {
    const outputScale = Math.min(PDF_CANVAS_MAX_DPR, input.devicePixelRatio, PDF_CANVAS_MAX_SIDE / Math.max(input.width, input.height));
    return { width: Math.max(1, Math.floor(input.width * outputScale)), height: Math.max(1, Math.floor(input.height * outputScale)), outputScale };
}

export function anchorPdfZoom(input: Readonly<{ scrollLeft: number; scrollTop: number; pointerX: number; pointerY: number; previousScale: number; nextScale: number }>) {
    const ratio = input.nextScale / input.previousScale;
    return { left: (input.scrollLeft + input.pointerX) * ratio - input.pointerX, top: (input.scrollTop + input.pointerY) * ratio - input.pointerY };
}
