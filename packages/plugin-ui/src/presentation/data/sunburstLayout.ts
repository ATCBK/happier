/**
 * Sunburst partition: the centre is the open folder, each ring out is one level deeper, arc length is
 * size. Angles start at 12 o'clock and run clockwise. Folding is in pixels of arc length at each ring's
 * middle radius, so inner rings fold earlier; a part shorter than that joins one "smaller items" arc per
 * parent — only when two or more would. A gap may be reserved at the end of the circle (another disk).
 * Pure: no drawing.
 */

export type HappierSunburstNode = Readonly<{
  key: string;
  value: number;
  children?: readonly HappierSunburstNode[];
}>;
export type HappierSunburstRing = Readonly<{ inner: number; outer: number }>;
export type HappierSunburstArc = Readonly<{
  key: string;
  parentKey: string | null;
  /** The ring, from 0 (innermost). */
  depth: number;
  /** Radians from 12 o'clock, clockwise. */
  a0: number;
  a1: number;
  value: number;
  /** A smaller-items arc: the keys it stands for (two or more); `null` for an ordinary arc. */
  folded: readonly string[] | null;
}>;
export type HappierSunburstLayoutOptions = Readonly<{
  rings: readonly HappierSunburstRing[];
  /** The shortest arc, in pixels at a ring's middle radius, that is its own arc. */
  minArcPx: number;
  gapRadians?: number;
}>;

export const HAPPIER_SUNBURST_SMALLER_SUFFIX = '\u0000smaller';
const TAU = Math.PI * 2;

function place(
  items: readonly HappierSunburstNode[],
  a0: number,
  span: number,
  whole: number,
  depth: number,
  parentKey: string | null,
  options: HappierSunburstLayoutOptions,
  out: HappierSunburstArc[],
) {
  const ring = options.rings[depth];
  if (!ring || whole <= 0 || span <= 0) return;
  const mid = (ring.inner + ring.outer) / 2;
  const spanOf = (value: number) => (Math.max(0, value) / whole) * span;
  const kept: HappierSunburstNode[] = [];
  const small: HappierSunburstNode[] = [];
  for (const item of items) {
    if (item.value <= 0) continue;
    (spanOf(item.value) * mid < options.minArcPx ? small : kept).push(item);
  }
  if (small.length === 1) {
    kept.push(small[0]!);
    small.length = 0;
  }
  // Kept parts in their given order; the fold closes the parent's span.
  const ordered = items.filter((item) => kept.includes(item));
  let angle = a0;
  for (const item of ordered) {
    const width = spanOf(item.value);
    out.push({
      key: item.key,
      parentKey,
      depth,
      a0: angle,
      a1: angle + width,
      value: item.value,
      folded: null,
    });
    if (item.children?.length)
      place(
        item.children,
        angle,
        width,
        item.value,
        depth + 1,
        item.key,
        options,
        out,
      );
    angle += width;
  }
  if (small.length >= 2) {
    const value = small.reduce((sum, item) => sum + item.value, 0);
    out.push({
      key: `${parentKey ?? ''}${HAPPIER_SUNBURST_SMALLER_SUFFIX}`,
      parentKey,
      depth,
      a0: angle,
      a1: angle + spanOf(value),
      value,
      folded: small.map((item) => item.key),
    });
  }
}

export function layoutHappierSunburst(
  nodes: readonly HappierSunburstNode[],
  options: HappierSunburstLayoutOptions,
): Readonly<{ arcs: readonly HappierSunburstArc[] }> {
  const arcs: HappierSunburstArc[] = [];
  const total = nodes.reduce((sum, node) => sum + Math.max(0, node.value), 0);
  place(
    nodes,
    0,
    TAU - (options.gapRadians ?? 0),
    total,
    0,
    null,
    options,
    arcs,
  );
  return { arcs };
}

/** Polar lookup: the ring from the distance, then the arc on that ring from the angle. */
export function hitHappierSunburst(
  arcs: readonly HappierSunburstArc[],
  rings: readonly HappierSunburstRing[],
  centre: Readonly<{ cx: number; cy: number }>,
  x: number,
  y: number,
): string | null {
  const dx = x - centre.cx;
  const dy = y - centre.cy;
  const r = Math.hypot(dx, dy);
  const depth = rings.findIndex((ring) => r >= ring.inner && r <= ring.outer);
  if (depth < 0) return null;
  let angle = Math.atan2(dx, -dy);
  if (angle < 0) angle += TAU;
  for (const arc of arcs)
    if (arc.depth === depth && angle >= arc.a0 && angle < arc.a1)
      return arc.key;
  return null;
}
