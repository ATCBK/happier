import { wheelZoomFactor, type ZoomPoint } from './zoomGeometry.ts';

export type WheelZoomTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & Readonly<{
    getBoundingClientRect(): Readonly<{ left: number; top: number; width: number; height: number }>;
}>;
export type WheelZoomHandlers = Readonly<{
    onZoom: (factor: number, focal: ZoomPoint) => void;
    onPan: (delta: ZoomPoint) => void;
    isZoomed: () => boolean;
}>;

/** The web wheel boundary, kept separate from pointer recognizers so modifiers are never lost. */
export function attachWheelZoom(target: WheelZoomTarget, handlers: WheelZoomHandlers): () => void {
    const listener: EventListener = (event) => {
        const wheel = event as WheelEvent;
        const zoom = wheel.ctrlKey || wheel.metaKey;
        if (!zoom && !handlers.isZoomed()) return;
        event.preventDefault();
        const rect = target.getBoundingClientRect();
        if (zoom) {
            handlers.onZoom(wheelZoomFactor(wheel.deltaY), {
                x: wheel.clientX - rect.left - rect.width / 2,
                y: wheel.clientY - rect.top - rect.height / 2,
            });
            return;
        }
        let unit = 1;
        if (wheel.deltaMode === 2) unit = rect.height;
        if (wheel.deltaMode === 1 && typeof Element !== 'undefined' && target instanceof Element) {
            const style = target.ownerDocument.defaultView?.getComputedStyle(target);
            const lineHeight = Number.parseFloat(style?.lineHeight ?? '') || Number.parseFloat(style?.fontSize ?? '');
            if (Number.isFinite(lineHeight)) unit = lineHeight;
        }
        handlers.onPan({ x: -wheel.deltaX * (wheel.deltaMode === 2 ? rect.width : unit), y: -wheel.deltaY * unit });
    };
    target.addEventListener('wheel', listener, { passive: false });
    return () => target.removeEventListener('wheel', listener);
}
