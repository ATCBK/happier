/** Window-space image geometry and the visible crop of a cover thumbnail. */
export type WindowFlightRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type RectFlipFrame = Readonly<{ imageRect: WindowFlightRect; clipRect: WindowFlightRect }>;
export type RectFlipOrigin = WindowFlightRect | RectFlipFrame;

export function rectFlipFrame(origin: RectFlipOrigin): RectFlipFrame {
    'worklet';
    return 'imageRect' in origin ? origin : { imageRect: origin, clipRect: origin };
}

function interpolateRect(from: WindowFlightRect, to: WindowFlightRect, progress: number): WindowFlightRect {
    'worklet';
    return {
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
        width: from.width + (to.width - from.width) * progress,
        height: from.height + (to.height - from.height) * progress,
    };
}

export function interpolateRectFlip(from: RectFlipFrame, to: RectFlipFrame, progress: number): RectFlipFrame {
    'worklet';
    return { imageRect: interpolateRect(from.imageRect, to.imageRect, progress), clipRect: interpolateRect(from.clipRect, to.clipRect, progress) };
}

/** Normalizes either opening (0→1) or an interrupted closing (current→0) onto the current leg. */
export function rectFlipLegProgress(progress: number, closing: boolean, closeFrom: number): number {
    'worklet';
    return closing ? (closeFrom === 0 ? 1 : 1 - progress / closeFrom) : progress;
}
