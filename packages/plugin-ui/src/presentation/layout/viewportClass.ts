export type HappierViewportClass = 'compact' | 'medium' | 'expanded' | 'wide';

export const HAPPIER_VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX = Object.freeze({
  tabletMin: 600,
  expandedMin: 840,
  wideMin: 1200,
});

export function resolveHappierViewportMinEdgePx(params: Readonly<{ width: number; height: number }>): number {
  const width = Number(params.width);
  const height = Number(params.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
  return Math.min(Math.abs(width), Math.abs(height));
}

/** The short edge keeps landscape phones in the same composition as portrait phones. */
export function resolveHappierViewportClass(params: Readonly<{ width: number; height: number }>): HappierViewportClass {
  const minEdge = resolveHappierViewportMinEdgePx(params);
  if (minEdge >= HAPPIER_VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.wideMin) return 'wide';
  if (minEdge >= HAPPIER_VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.expandedMin) return 'expanded';
  if (minEdge >= HAPPIER_VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.tabletMin) return 'medium';
  return 'compact';
}
