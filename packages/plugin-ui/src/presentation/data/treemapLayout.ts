/**
 * Squarified treemap layout (running sums, one row at a time along the shorter side) with folding in
 * pixels: a part too small to be its own tile at the host's minimum tile size folds into one "smaller
 * items" tile — only when two or more fold, so a fold always stands for several things. A second level
 * is laid out inside a tile below its label band only where that tile has room for it. Pure: no drawing.
 */

export type HappierTreemapRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;
export type HappierTreemapNode = Readonly<{
  key: string;
  value: number;
  children?: readonly HappierTreemapNode[];
}>;
export type HappierTreemapTile = Readonly<{
  key: string;
  parentKey: string | null;
  depth: 0 | 1;
  /** Already inset by the gap between tiles. */
  rect: HappierTreemapRect;
  value: number;
  /** Large enough to carry its name. */
  labeled: boolean;
  /** A smaller-items tile: the keys it stands for (two or more); `null` for an ordinary tile. */
  folded: readonly string[] | null;
}>;
export type HappierTreemapLayoutOptions = Readonly<{
  width: number;
  height: number;
  minNodePx: Readonly<{ width: number; height: number }>;
  gapPx?: number;
  /** The label band at the top of a tile that holds a second level. */
  headerPx?: number;
}>;

/** The key of a level's smaller-items tile: its parent's key (or the root's) and a suffix. */
export const HAPPIER_TREEMAP_SMALLER_SUFFIX = '\u0000smaller';

type Weighted = Readonly<{ key: string; value: number }>;

function worst(row: readonly number[], side: number): number {
  const sum = row.reduce((total, area) => total + area, 0);
  const max = Math.max(...row);
  const min = Math.min(...row);
  return Math.max(
    (side * side * max) / (sum * sum),
    (sum * sum) / (side * side * min),
  );
}

export function squarifyHappierTreemap(
  items: readonly Weighted[],
  bounds: HappierTreemapRect,
): readonly Readonly<{ key: string; rect: HappierTreemapRect }>[] {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  if (total <= 0 || bounds.width <= 0 || bounds.height <= 0)
    return items.map((item) => ({
      key: item.key,
      rect: { ...bounds, width: 0, height: 0 },
    }));
  const scale = (bounds.width * bounds.height) / total;
  const areas = items.map((item) => Math.max(0, item.value) * scale);
  const out: { key: string; rect: HappierTreemapRect }[] = [];
  let { x, y, width, height } = bounds;
  let start = 0;
  while (start < items.length) {
    const side = Math.min(width, height);
    let end = start + 1;
    let best = worst([areas[start]!], side);
    while (end < items.length) {
      const next = worst(areas.slice(start, end + 1), side);
      if (next > best) break;
      best = next;
      end++;
    }
    const row = areas.slice(start, end);
    const sum = row.reduce((total, area) => total + area, 0);
    const thick = side > 0 ? sum / side : 0;
    let offset = 0;
    for (let index = start; index < end; index++) {
      const length = thick > 0 ? areas[index]! / thick : 0;
      out.push({
        key: items[index]!.key,
        rect:
          width >= height
            ? { x, y: y + offset, width: thick, height: length }
            : { x: x + offset, y, width: length, height: thick },
      });
      offset += length;
    }
    if (width >= height) {
      x += thick;
      width -= thick;
    } else {
      y += thick;
      height -= thick;
    }
    start = end;
  }
  return out;
}

/** Parts that may stand alone at this area; the rest fold (only when two or more would). */
function foldByArea(
  items: readonly HappierTreemapNode[],
  area: number,
  min: Readonly<{ width: number; height: number }>,
  foldKey: string,
) {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  if (total <= 0)
    return {
      kept: [] as HappierTreemapNode[],
      folded: [] as HappierTreemapNode[],
      foldKey,
    };
  const minArea = min.width * min.height;
  const kept: HappierTreemapNode[] = [];
  const folded: HappierTreemapNode[] = [];
  for (const item of items) {
    if (item.value <= 0) continue;
    ((item.value / total) * area < minArea ? folded : kept).push(item);
  }
  if (folded.length === 1) {
    kept.push(folded[0]!);
    folded.length = 0;
  }
  return { kept, folded, foldKey };
}

function inset(rect: HappierTreemapRect, gap: number): HappierTreemapRect {
  return {
    x: rect.x,
    y: rect.y,
    width: Math.max(0, rect.width - gap),
    height: Math.max(0, rect.height - gap),
  };
}

function fits(
  rect: HappierTreemapRect,
  min: Readonly<{ width: number; height: number }>,
) {
  return rect.width >= min.width && rect.height >= min.height;
}

function layoutLevel(
  items: readonly HappierTreemapNode[],
  bounds: HappierTreemapRect,
  options: Required<Pick<HappierTreemapLayoutOptions, 'gapPx' | 'headerPx'>> &
    Pick<HappierTreemapLayoutOptions, 'minNodePx'>,
  parentKey: string | null,
  depth: 0 | 1,
  out: HappierTreemapTile[],
) {
  const { kept, folded, foldKey } = foldByArea(
    items,
    bounds.width * bounds.height,
    options.minNodePx,
    `${parentKey ?? ''}${HAPPIER_TREEMAP_SMALLER_SUFFIX}`,
  );
  const smaller =
    folded.length >= 2
      ? {
          key: foldKey,
          value: folded.reduce((sum, item) => sum + item.value, 0),
        }
      : null;
  const weighted: Weighted[] = [
    ...kept.map((item) => ({ key: item.key, value: item.value })),
    ...(smaller ? [smaller] : []),
  ];
  const byKey = new Map(kept.map((item) => [item.key, item]));
  for (const { key, rect } of squarifyHappierTreemap(weighted, bounds)) {
    const node = byKey.get(key);
    const drawn = inset(rect, options.gapPx);
    out.push({
      key,
      parentKey,
      depth,
      rect: drawn,
      value: node ? node.value : smaller!.value,
      labeled: fits(drawn, options.minNodePx),
      folded: node ? null : folded.map((item) => item.key),
    });
    if (depth === 0 && node?.children?.length) {
      const inner: HappierTreemapRect = {
        x: drawn.x + options.gapPx * 2,
        y: drawn.y + options.headerPx,
        width: drawn.width - options.gapPx * 4,
        height: drawn.height - options.headerPx - options.gapPx * 2,
      };
      // A second level only where at least two of its tiles could carry a name.
      if (
        inner.width >= options.minNodePx.width &&
        inner.height >= options.minNodePx.height * 2 &&
        inner.width * inner.height >=
          2 * options.minNodePx.width * options.minNodePx.height
      ) {
        layoutLevel(node.children, inner, options, key, 1, out);
      }
    }
  }
}

export function layoutHappierTreemap(
  nodes: readonly HappierTreemapNode[],
  options: HappierTreemapLayoutOptions,
): Readonly<{ tiles: readonly HappierTreemapTile[] }> {
  const tiles: HappierTreemapTile[] = [];
  layoutLevel(
    nodes,
    { x: 0, y: 0, width: options.width, height: options.height },
    {
      minNodePx: options.minNodePx,
      gapPx: options.gapPx ?? 2,
      headerPx: options.headerPx ?? 34,
    },
    null,
    0,
    tiles,
  );
  return { tiles };
}

/**
 * A bucket grid over the drawn tiles: each cell lists the tiles crossing it, deepest last, so a pointer
 * lookup reads one short list instead of every tile.
 */
export function createHappierTreemapHitGrid(
  tiles: readonly HappierTreemapTile[],
  size: Readonly<{ width: number; height: number }>,
  cellPx = 32,
): (x: number, y: number) => string | null {
  const columns = Math.max(1, Math.ceil(size.width / cellPx));
  const rows = Math.max(1, Math.ceil(size.height / cellPx));
  const cells: HappierTreemapTile[][] = Array.from(
    { length: columns * rows },
    () => [],
  );
  const ordered = [...tiles].sort((a, b) => a.depth - b.depth);
  for (const tile of ordered) {
    const { x, y, width, height } = tile.rect;
    if (width <= 0 || height <= 0) continue;
    const c0 = Math.max(0, Math.floor(x / cellPx));
    const c1 = Math.min(columns - 1, Math.floor((x + width) / cellPx));
    const r0 = Math.max(0, Math.floor(y / cellPx));
    const r1 = Math.min(rows - 1, Math.floor((y + height) / cellPx));
    for (let row = r0; row <= r1; row++)
      for (let column = c0; column <= c1; column++)
        cells[row * columns + column]!.push(tile);
  }
  return (x, y) => {
    if (x < 0 || y < 0 || x > size.width || y > size.height) return null;
    const cell =
      cells[
        Math.min(rows - 1, Math.floor(y / cellPx)) * columns +
          Math.min(columns - 1, Math.floor(x / cellPx))
      ] ?? [];
    for (let index = cell.length - 1; index >= 0; index--) {
      const { rect, key } = cell[index]!;
      if (
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
      )
        return key;
    }
    return null;
  };
}
