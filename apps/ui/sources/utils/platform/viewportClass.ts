import type { HappierViewportClass as ViewportClass } from '@happier-dev/plugin-ui/presentation';

export {
    HAPPIER_VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX as VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX,
    resolveHappierViewportClass as resolveViewportClass,
    resolveHappierViewportMinEdgePx as resolveViewportMinEdgePx,
    type HappierViewportClass as ViewportClass,
} from '@happier-dev/plugin-ui/presentation';

export const CONSTRAINED_MAX_WIDTH_PX_BY_VIEWPORT_CLASS = Object.freeze({
    compact: 800,
    medium: 960,
    expanded: 1200,
    wide: 1400,
} satisfies Record<ViewportClass, number>);
