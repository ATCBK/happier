import * as React from 'react';

import { attachWheelZoom, type WheelZoomHandlers, type WheelZoomTarget } from './wheelZoom';

function isWheelZoomTarget(value: unknown): value is WheelZoomTarget {
    if (value === null || typeof value !== 'object') return false;
    return 'addEventListener' in value && typeof value.addEventListener === 'function'
        && 'removeEventListener' in value && typeof value.removeEventListener === 'function'
        && 'getBoundingClientRect' in value && typeof value.getBoundingClientRect === 'function';
}

export function useWheelZoom(target: React.RefObject<unknown>, handlers: WheelZoomHandlers): void {
    const latest = React.useRef(handlers);
    latest.current = handlers;
    React.useEffect(() => {
        if (!isWheelZoomTarget(target.current)) return;
        return attachWheelZoom(target.current, {
            onZoom: (factor, focal) => latest.current.onZoom(factor, focal),
            onPan: (delta) => latest.current.onPan(delta),
            isZoomed: () => latest.current.isZoomed(),
        });
    }, [target]);
}
