import { describe, expect, it } from 'vitest';

import {
  createHappierTreemapHitGrid,
  layoutHappierTreemap,
  squarifyHappierTreemap,
  type HappierTreemapRect,
} from './treemapLayout.js';

const area = (rect: HappierTreemapRect) => rect.width * rect.height;
const inside = (rect: HappierTreemapRect, bounds: HappierTreemapRect) =>
  rect.x >= bounds.x - 1e-6 &&
  rect.y >= bounds.y - 1e-6 &&
  rect.x + rect.width <= bounds.x + bounds.width + 1e-6 &&
  rect.y + rect.height <= bounds.y + bounds.height + 1e-6;
const overlap = (a: HappierTreemapRect, b: HappierTreemapRect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

const MIN = { width: 56, height: 20 } as const;

describe('squarified treemap layout', () => {
  it('gives each item an area proportional to its value, inside the bounds, without overlap and near-square', () => {
    const bounds = { x: 0, y: 0, width: 600, height: 400 };
    const items = [6, 6, 4, 3, 2, 2, 1].map((value, index) => ({
      key: `k${index}`,
      value,
    }));
    const rects = squarifyHappierTreemap(items, bounds);
    expect(rects.map((entry) => entry.key)).toEqual(
      items.map((item) => item.key),
    );
    const total = items.reduce((sum, item) => sum + item.value, 0);
    for (const [index, entry] of rects.entries()) {
      expect(inside(entry.rect, bounds)).toBe(true);
      expect(area(entry.rect) / area(bounds)).toBeCloseTo(
        items[index]!.value / total,
        6,
      );
      const ratio = Math.max(
        entry.rect.width / entry.rect.height,
        entry.rect.height / entry.rect.width,
      );
      // The classic squarified example stays under a 3:1 worst ratio; a slice-and-dice layout would not.
      expect(ratio).toBeLessThan(3);
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        expect(overlap(rects[i]!.rect, rects[j]!.rect)).toBeLessThan(1e-6);
      }
  });
});

describe('treemap of one folder level with pixel folding', () => {
  it('folds two or more children too small to be their own tile into one smaller-items tile carrying their keys and bytes', () => {
    const nodes = [
      { key: 'big', value: 900 },
      { key: 'mid', value: 300 },
      { key: 'tiny-a', value: 0.4 },
      { key: 'tiny-b', value: 0.3 },
      { key: 'tiny-c', value: 0.2 },
    ];
    const { tiles } = layoutHappierTreemap(nodes, {
      width: 760,
      height: 300,
      minNodePx: MIN,
    });
    const top = tiles.filter((tile) => tile.depth === 0);
    expect(top.map((tile) => tile.key)).toEqual([
      'big',
      'mid',
      expect.any(String),
    ]);
    const smaller = top[2]!;
    expect(smaller.folded).toEqual(['tiny-a', 'tiny-b', 'tiny-c']);
    expect(smaller.value).toBeCloseTo(0.9, 6);
    // Folding never drops bytes: the drawn tiles still cover the whole chart in proportion.
    expect(top.reduce((sum, tile) => sum + tile.value, 0)).toBeCloseTo(
      1200.9,
      6,
    );
  });

  it('keeps a single small child as its own (unlabelled) tile instead of a one-item fold', () => {
    const { tiles } = layoutHappierTreemap(
      [
        { key: 'big', value: 1000 },
        { key: 'tiny', value: 0.5 },
      ],
      { width: 760, height: 300, minNodePx: MIN },
    );
    const tiny = tiles.find((tile) => tile.key === 'tiny');
    expect(tiny?.folded).toBeNull();
    expect(tiny?.labeled).toBe(false);
    expect(tiles.find((tile) => tile.key === 'big')?.labeled).toBe(true);
  });

  it('draws a second level only inside tiles with room for it, below the tile label band', () => {
    const nodes = [
      {
        key: 'dev',
        value: 600,
        children: [
          { key: 'dev/a', value: 400 },
          { key: 'dev/b', value: 200 },
        ],
      },
      {
        key: 'lib',
        value: 2,
        children: [
          { key: 'lib/x', value: 1 },
          { key: 'lib/y', value: 1 },
        ],
      },
    ];
    const { tiles } = layoutHappierTreemap(nodes, {
      width: 760,
      height: 300,
      minNodePx: MIN,
      headerPx: 30,
    });
    const dev = tiles.find((tile) => tile.key === 'dev')!;
    const kids = tiles.filter((tile) => tile.parentKey === 'dev');
    expect(kids.map((tile) => tile.key)).toEqual(['dev/a', 'dev/b']);
    for (const kid of kids) {
      expect(kid.depth).toBe(1);
      expect(inside(kid.rect, dev.rect)).toBe(true);
      expect(kid.rect.y).toBeGreaterThanOrEqual(dev.rect.y + 30 - 1e-6);
    }
    expect(tiles.some((tile) => tile.parentKey === 'lib')).toBe(false);
  });

  it('never draws more top-level tiles than fit at the minimum tile size', () => {
    const nodes = Array.from({ length: 1000 }, (_, index) => ({
      key: `n${index}`,
      value: 1,
    }));
    const { tiles } = layoutHappierTreemap(nodes, {
      width: 760,
      height: 300,
      minNodePx: MIN,
    });
    const drawable = Math.floor((760 * 300) / (MIN.width * MIN.height));
    expect(tiles.filter((tile) => tile.depth === 0).length).toBeLessThanOrEqual(
      drawable + 1,
    );
  });
});

describe('treemap hit grid', () => {
  it('answers the deepest tile under a point, and nothing outside the chart', () => {
    const nodes = [
      {
        key: 'dev',
        value: 600,
        children: [
          { key: 'dev/a', value: 400 },
          { key: 'dev/b', value: 200 },
        ],
      },
      { key: 'lib', value: 300 },
    ];
    const { tiles } = layoutHappierTreemap(nodes, {
      width: 760,
      height: 300,
      minNodePx: MIN,
      headerPx: 30,
    });
    const hit = createHappierTreemapHitGrid(tiles, { width: 760, height: 300 });
    const kid = tiles.find((tile) => tile.key === 'dev/a')!;
    expect(
      hit(kid.rect.x + kid.rect.width / 2, kid.rect.y + kid.rect.height / 2),
    ).toBe('dev/a');
    const dev = tiles.find((tile) => tile.key === 'dev')!;
    expect(hit(dev.rect.x + 4, dev.rect.y + 4)).toBe('dev');
    const lib = tiles.find((tile) => tile.key === 'lib')!;
    expect(
      hit(lib.rect.x + lib.rect.width / 2, lib.rect.y + lib.rect.height / 2),
    ).toBe('lib');
    expect(hit(-5, 10)).toBeNull();
    expect(hit(800, 10)).toBeNull();
  });
});
