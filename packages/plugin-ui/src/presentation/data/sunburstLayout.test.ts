import { describe, expect, it } from 'vitest';

import { hitHappierSunburst, layoutHappierSunburst } from './sunburstLayout.js';

const RINGS = [
  { inner: 56, outer: 104 },
  { inner: 107, outer: 140 },
  { inner: 143, outer: 160 },
] as const;
const TAU = Math.PI * 2;
const span = (arc: { a0: number; a1: number }) => arc.a1 - arc.a0;

describe('sunburst partition', () => {
  it('splits the circle among one level in proportion and nests each child inside its parent', () => {
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
      { key: 'mov', value: 100 },
    ];
    const { arcs } = layoutHappierSunburst(nodes, {
      rings: RINGS,
      minArcPx: 1,
    });
    const top = arcs.filter((arc) => arc.depth === 0);
    expect(top.map((arc) => arc.key)).toEqual(['dev', 'lib', 'mov']);
    expect(top.reduce((sum, arc) => sum + span(arc), 0)).toBeCloseTo(TAU, 6);
    expect(span(top[0]!) / TAU).toBeCloseTo(0.6, 6);
    expect(top[0]!.a0).toBeCloseTo(0, 6);
    const dev = top[0]!;
    const kids = arcs.filter((arc) => arc.parentKey === 'dev');
    expect(kids.map((arc) => [arc.key, arc.depth])).toEqual([
      ['dev/a', 1],
      ['dev/b', 1],
    ]);
    for (const kid of kids) {
      expect(kid.a0).toBeGreaterThanOrEqual(dev.a0 - 1e-9);
      expect(kid.a1).toBeLessThanOrEqual(dev.a1 + 1e-9);
    }
    expect(span(kids[0]!) / span(dev)).toBeCloseTo(400 / 600, 6);
  });

  it('leaves a reserved gap at the end of the circle (another disk) and shares the rest', () => {
    const gap = (5 / 180) * Math.PI;
    const { arcs } = layoutHappierSunburst(
      [
        { key: 'a', value: 1 },
        { key: 'b', value: 1 },
      ],
      { rings: RINGS, minArcPx: 1, gapRadians: gap },
    );
    expect(arcs[1]!.a1).toBeCloseTo(TAU - gap, 6);
  });

  it('folds two or more arcs shorter than the minimum length at their ring into one smaller-items arc; inner rings fold earlier', () => {
    const nodes = [
      {
        key: 'A',
        value: 0.97,
        children: [
          { key: 'A1', value: 0.94 },
          { key: 'A2', value: 0.015 },
          { key: 'A3', value: 0.015 },
        ],
      },
      { key: 'B', value: 0.015 },
      { key: 'C', value: 0.015 },
    ];
    // At ring 0 (mid 80 px) a 1.5% arc is ~7.5 px; at ring 1 (mid 123.5 px) ~11.6 px.
    const { arcs } = layoutHappierSunburst(nodes, {
      rings: RINGS,
      minArcPx: 9,
    });
    const top = arcs.filter((arc) => arc.depth === 0);
    expect(top.map((arc) => arc.folded)).toEqual([null, ['B', 'C']]);
    expect(top[1]!.value).toBeCloseTo(0.03, 6);
    expect(
      arcs.filter((arc) => arc.parentKey === 'A').map((arc) => arc.key),
    ).toEqual(['A1', 'A2', 'A3']);
  });

  it('keeps a single short arc on its own rather than folding one item', () => {
    const { arcs } = layoutHappierSunburst(
      [
        { key: 'big', value: 1 },
        { key: 'tiny', value: 0.001 },
      ],
      { rings: RINGS, minArcPx: 9 },
    );
    expect(arcs.map((arc) => [arc.key, arc.folded])).toEqual([
      ['big', null],
      ['tiny', null],
    ]);
  });

  it('draws no deeper than the rings it is given', () => {
    const nodes = [
      {
        key: 'a',
        value: 1,
        children: [
          {
            key: 'b',
            value: 1,
            children: [
              { key: 'c', value: 1, children: [{ key: 'd', value: 1 }] },
            ],
          },
        ],
      },
    ];
    const { arcs } = layoutHappierSunburst(nodes, {
      rings: RINGS,
      minArcPx: 1,
    });
    expect(arcs.map((arc) => arc.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('sunburst polar hit lookup', () => {
  it('answers the arc under a point by ring and angle, and nothing in the hole, a ring gap or outside', () => {
    const nodes = [
      { key: 'east', value: 1 },
      { key: 'west', value: 1 },
    ];
    const { arcs } = layoutHappierSunburst(nodes, {
      rings: RINGS,
      minArcPx: 1,
    });
    const centre = { cx: 200, cy: 200 };
    expect(hitHappierSunburst(arcs, RINGS, centre, 200 + 80, 200)).toBe('east');
    expect(hitHappierSunburst(arcs, RINGS, centre, 200 - 80, 200)).toBe('west');
    expect(hitHappierSunburst(arcs, RINGS, centre, 200, 200)).toBeNull();
    expect(hitHappierSunburst(arcs, RINGS, centre, 200 + 105, 200)).toBeNull();
    expect(hitHappierSunburst(arcs, RINGS, centre, 200 + 300, 200)).toBeNull();
  });
});
