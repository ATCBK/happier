import { cropOf, backdropBandGrade, renderBackdrop, type AtmosphereGrade, type AtmospherePixels } from '@happier-dev/brand/atmosphere';
import type { BackdropRenderRequest, BackdropWorkerRequest, BackdropWorkerResponse } from './backdropCanvas.types';

// This file is bundled as a dedicated public worker; it is never imported by the UI.
const worker = self as unknown as {
    onmessage: ((event: MessageEvent<BackdropWorkerRequest>) => void) | null;
    postMessage: (message: BackdropWorkerResponse, transfer?: Transferable[]) => void;
};

/** The grade's horizon row in the cropped band (lab `compute`). */
function bandGrade(request: BackdropRenderRequest, source: { w: number; h: number }) {
    const grade = request.job.grade;
    const crop = cropOf(source, request.job.span?.W ?? request.width, request.job.span?.H ?? request.height, request.focus, request.horizon);
    return backdropBandGrade(grade, crop, request.horizon);
}

async function sourcePixels(request: BackdropRenderRequest): Promise<Readonly<{ pixels: AtmospherePixels; grade: AtmosphereGrade | null | undefined }>> {
    const source = request.source;
    if ('rgba' in source && source.w === request.width && source.h === request.height) return { pixels: source, grade: bandGrade(request, source) };
    const bitmap = 'rgba' in source
        ? await createImageBitmap(new ImageData(new Uint8ClampedArray(source.rgba), source.w, source.h))
        : await createImageBitmap(typeof source.data === 'string' ? await (await fetch(source.data)).blob() : source.data);
    try {
        const crop = cropOf({ w: bitmap.width, h: bitmap.height }, request.job.span?.W ?? request.width,
            request.job.span?.H ?? request.height, request.focus, request.horizon);
        const canvas = new OffscreenCanvas(request.width, request.height);
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Atmosphere source canvas is unavailable');
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, crop.sx + (request.job.span?.x ?? 0) / crop.s, crop.sy + (request.job.span?.y ?? 0) / crop.s,
            request.width / crop.s, request.height / crop.s, 0, 0, request.width, request.height);
        return { pixels: { rgba: context.getImageData(0, 0, request.width, request.height).data, w: request.width, h: request.height },
            grade: bandGrade(request, { w: bitmap.width, h: bitmap.height }) };
    } finally { bitmap.close(); }
}

worker.onmessage = async event => {
    const message = event.data;
    try {
        let job;
        if ('job' in message) job = message.job;
        else { const { pixels, grade } = await sourcePixels(message.request); job = { ...message.request.job, grade, source: pixels }; }
        const result = renderBackdrop(job);
        worker.postMessage({ id: message.id, ok: true, result }, [result.rgba.buffer]);
    } catch (error) {
        worker.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
};
