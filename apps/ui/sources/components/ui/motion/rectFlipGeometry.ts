/** Window-space image geometry and the visible crop of a cover thumbnail. */
export type WindowFlightRect = Readonly<{ x: number; y: number; width: number; height: number }>;
export type RectFlipFrame = Readonly<{ imageRect: WindowFlightRect; clipRect: WindowFlightRect }>;
export type RectFlipOrigin = WindowFlightRect | RectFlipFrame;

/** Destination-local transform for a visible window-space rectangle. */
export function rectFlipTransform(rect: WindowFlightRect, target: WindowFlightRect) {
    'worklet';
    return {
        translateX: rect.x - target.x,
        translateY: rect.y - target.y,
        scaleX: rect.width / target.width,
        scaleY: rect.height / target.height,
    };
}

export function rectFlipFrame(origin: RectFlipOrigin): RectFlipFrame {
    'worklet';
    return 'imageRect' in origin ? origin : { imageRect: origin, clipRect: origin };
}

/** The image's uncropped bounds inside a centre-cover thumbnail, in the same window coordinates. */
export function coverRectFlipOrigin(clipRect: WindowFlightRect, image: Pick<WindowFlightRect, 'width' | 'height'>): RectFlipFrame {
    const scale = Math.max(clipRect.width / image.width, clipRect.height / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    return { imageRect: { x: clipRect.x + (clipRect.width - width) / 2, y: clipRect.y + (clipRect.height - height) / 2, width, height }, clipRect };
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
