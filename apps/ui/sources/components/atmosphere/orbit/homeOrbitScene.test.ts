import { describe, expect, it } from 'vitest';

import { layoutHomeOrbitScene, type HomeOrbitBody } from './homeOrbitScene';

const body = (
  key: string,
  online: boolean,
  tones: readonly HomeOrbitBody['dots'][number]['tone'][] = [],
): HomeOrbitBody => ({
  key,
  online,
  dots: tones.map((tone, index) => ({ key: `${key}-${index}`, tone })),
});

describe('Home orbit scene (lab at-widget.js scene())', () => {
  it('places moons on their orbits and trails dots behind them, dimming offline orbits', () => {
    const scene = layoutHomeOrbitScene(
      262,
      196,
      [body('mbp', true, ['active', 'attention']), body('win', false)],
      {
        pr: 40,
        radii: [1.55, 1.97, 2.4].map((k) => k * 40),
        angles: [-38, 214, 128],
      },
    );
    expect(scene.orbits).toEqual([
      { r: 62, off: false },
      { r: 79, off: true },
    ]);
    expect(scene.moons[0]!.x).toBeCloseTo(
      131 + Math.cos((-38 * Math.PI) / 180) * 62,
      6,
    );
    expect(scene.moons.map((moon) => [moon.key, moon.off])).toEqual([
      ['mbp', false],
      ['win', true],
    ]);
    // Dots carry their body and tone, so a preview can light one skill's dots on every machine.
    expect(scene.dots.map((dot) => [dot.bodyKey, dot.key, dot.tone])).toEqual([
      ['mbp', 'mbp-0', 'active'],
      ['mbp', 'mbp-1', 'attention'],
    ]);
    // The first dot trails 11 px of arc behind its moon (counter-clockwise on the right side).
    const angle = -38 - (11 / 62) * (180 / Math.PI);
    expect(scene.dots[0]!.x).toBeCloseTo(
      131 + Math.cos((angle * Math.PI) / 180) * 62,
      6,
    );
    expect(scene.canvas).toEqual({ left: 131 - 84, top: 98 - 84, size: 168 });
  });

  it('draws an offline body’s last-known dots when the caller supplies them', () => {
    const scene = layoutHomeOrbitScene(
      300,
      300,
      [body('win', false, ['quiet', 'quiet'])],
      { pr: 40, dotGap: 8.6 },
    );
    expect(scene.dots.map((dot) => dot.bodyKey)).toEqual(['win', 'win']);
  });

  it('draws two quiet orbits around an empty Home', () => {
    const scene = layoutHomeOrbitScene(262, 120, [], { pr: 18, small: true });
    expect(scene.orbits).toEqual([
      { r: 35, off: true },
      { r: 62, off: true },
    ]);
    expect(scene.moons).toEqual([]);
  });

  it('past the orbit count, bodies share the outer orbit (drawn once) and spread evenly', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((key) => body(key, true));
    const scene = layoutHomeOrbitScene(300, 300, five, {
      pr: 40,
      radii: [62, 79, 96],
      angles: [-38, 214, 128],
    });
    expect(scene.orbits.map((orbit) => orbit.r)).toEqual([62, 79, 96]);
    const outer = scene.moons
      .slice(2)
      .map((moon) =>
        Math.round(
          (Math.atan2(moon.y - scene.py, moon.x - scene.px) * 180) / Math.PI,
        ),
      );
    expect(new Set(outer).size).toBe(3);
    expect(outer[0]).toBe(128);
  });
});
