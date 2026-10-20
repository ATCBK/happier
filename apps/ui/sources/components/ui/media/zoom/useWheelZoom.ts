import type * as React from 'react';

import type { WheelZoomHandlers } from './wheelZoom';

/** Pointer wheel events exist only on web; native recognizers own pinch and pan. */
export function useWheelZoom(_target: React.RefObject<unknown>, _handlers: WheelZoomHandlers): void {}
