import type { YourHomeSessionState } from './yourHomeModel';

/**
 * The orbit scene of the "Your Home" widget, moved from the atmosphere lab (`at-widget.js scene()`):
 * flat, faint dotted circles centred on the planet; each machine is a moon on its circle, and its
 * sessions trail behind it as dots on the same circle. Every orbit is wider than the planet and its
 * glow, so nothing ever crosses in front of it. Geometry only: the planet is drawn by PlanetCanvas.
 */
export type YourHomeSceneMachine = Readonly<{
  online: boolean;
  shown: readonly YourHomeSessionState[];
}>;

export type YourHomeSceneOptions = Readonly<{
  pr?: number;
  px?: number;
  py?: number;
  /** Orbit radii in px (the lab passes multiples of `pr`). */
  radii?: readonly number[];
  /** Each moon's angle on its orbit, in degrees. */
  angles?: readonly number[];
  small?: boolean;
}>;

export type YourHomeScene = Readonly<{
  width: number;
  height: number;
  /** The planet's centre and radius. */
  px: number;
  py: number;
  pr: number;
  orbits: readonly Readonly<{ r: number; off: boolean }>[];
  sessions: readonly Readonly<{
    x: number;
    y: number;
    state: YourHomeSessionState;
  }>[];
  moons: readonly Readonly<{ x: number; y: number; r: number; off: boolean }>[];
  /** The planet canvas: a square of 4.2 planet radii centred on the planet. */
  canvas: Readonly<{ left: number; top: number; size: number }>;
}>;

export function layoutYourHomeScene(
  w: number,
  h: number,
  machines: readonly YourHomeSceneMachine[],
  o: YourHomeSceneOptions = {},
): YourHomeScene {
  const pr = Math.round(o.pr || Math.min(h, w) * 0.16);
  const px = Math.round(o.px != null ? o.px : w / 2),
    py = Math.round(o.py != null ? o.py : h / 2);
  const radii = (o.radii || [1.95, 2.7, 3.45].map((k) => k * pr)).map(
    Math.round,
  );
  const angles = o.angles || [-18, 200, 155];
  const at = (r: number, deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [px + Math.cos(a) * r, py + Math.sin(a) * r];
  };
  const last = radii[radii.length - 1]!;
  // The lab draws three machines. Past them, every machine shares the outer orbit (drawn once) and
  // the moons there are spaced evenly from its lab angle, so no two moons or orbits sit on each other.
  const shared = Math.max(1, machines.length - (radii.length - 1));
  const radiusOf = (k: number) => radii[k] || last;
  const angleOf = (k: number) => {
    if (machines.length <= radii.length) return angles[k] != null ? angles[k]! : k * 120;
    const outer = radii.length - 1;
    if (k < outer) return angles[k] != null ? angles[k]! : k * 120;
    return (angles[outer] != null ? angles[outer]! : outer * 120) + ((k - outer) * 360) / shared;
  };
  const orbits = machines.length
    ? [...new Set(machines.map((_, k) => radiusOf(k)))].map((r) => ({
        r,
        off: machines.every((m, k) => radiusOf(k) !== r || !m.online),
      }))
    : [
        { r: radii[0]!, off: true },
        { r: radii[Math.min(2, radii.length - 1)]!, off: true },
      ];
  const sessions: { x: number; y: number; state: YourHomeSessionState }[] = [];
  const moons = machines.map((m, k) => {
    const r = radiusOf(k);
    const off = !m.online;
    const a0 = angleOf(k);
    const [mx, my] = at(r, a0);
    const step = (11 / r) * (180 / Math.PI);
    if (!off)
      m.shown.forEach((state, i) => {
        const [sx, sy] = at(
          r,
          a0 + (i + 1) * step * (a0 > 90 && a0 < 270 ? -1 : 1) * -1,
        );
        sessions.push({ x: sx, y: sy, state });
      });
    return { x: mx, y: my, r: o.small ? 3.6 : 4.4, off };
  });
  const size = pr * 4.2;
  return {
    width: w,
    height: h,
    px,
    py,
    pr,
    orbits,
    sessions,
    moons,
    canvas: { left: px - size / 2, top: py - size / 2, size },
  };
}
