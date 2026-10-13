/**
 * The Home orbit scene, moved from the atmosphere lab (`at-widget.js scene()`): flat, faint dotted
 * circles centred on the planet; each body (a machine) is a moon on its circle, and what it holds
 * trails behind it as dots on the same circle. Every orbit is wider than the planet and its glow, so
 * nothing ever crosses in front of it. Geometry only: the planet is drawn by PlanetCanvas.
 *
 * One owner for every orbit drawing: the Your Home widget (sessions per machine) and the capability
 * homepages (skills per machine) both lay out through here and draw through `HomeOrbitMap`.
 */
export type HomeOrbitDotTone = 'quiet' | 'active' | 'attention' | 'hollow';

export type HomeOrbitBody = Readonly<{
  key: string;
  online: boolean;
  dots: readonly Readonly<{ key: string; tone: HomeOrbitDotTone }>[];
}>;

export type HomeOrbitOptions = Readonly<{
  pr?: number;
  px?: number;
  py?: number;
  /** Orbit radii in px (callers pass multiples of `pr`). */
  radii?: readonly number[];
  /** Each moon's angle on its orbit, in degrees. */
  angles?: readonly number[];
  small?: boolean;
  /** Arc between two dots on an orbit, in px (the widget's sessions sit 11 px apart). */
  dotGap?: number;
}>;

export type HomeOrbitScene = Readonly<{
  width: number;
  height: number;
  /** The planet's centre and radius. */
  px: number;
  py: number;
  pr: number;
  orbits: readonly Readonly<{ r: number; off: boolean }>[];
  moons: readonly Readonly<{
    key: string;
    x: number;
    y: number;
    r: number;
    off: boolean;
  }>[];
  dots: readonly Readonly<{
    key: string;
    bodyKey: string;
    x: number;
    y: number;
    tone: HomeOrbitDotTone;
  }>[];
  /** The planet canvas: a square of 4.2 planet radii centred on the planet. */
  canvas: Readonly<{ left: number; top: number; size: number }>;
}>;

export function layoutHomeOrbitScene(
  w: number,
  h: number,
  bodies: readonly HomeOrbitBody[],
  o: HomeOrbitOptions = {},
): HomeOrbitScene {
  const pr = Math.round(o.pr || Math.min(h, w) * 0.16);
  const px = Math.round(o.px != null ? o.px : w / 2),
    py = Math.round(o.py != null ? o.py : h / 2);
  const radii = (o.radii || [1.95, 2.7, 3.45].map((k) => k * pr)).map(
    Math.round,
  );
  const angles = o.angles || [-18, 200, 155];
  const gap = o.dotGap ?? 11;
  const at = (r: number, deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [px + Math.cos(a) * r, py + Math.sin(a) * r];
  };
  const last = radii[radii.length - 1]!;
  // The lab draws three bodies. Past them, every body shares the outer orbit (drawn once) and the
  // moons there are spaced evenly from its lab angle, so no two moons or orbits sit on each other.
  const shared = Math.max(1, bodies.length - (radii.length - 1));
  const radiusOf = (k: number) => radii[k] || last;
  const angleOf = (k: number) => {
    if (bodies.length <= radii.length)
      return angles[k] != null ? angles[k]! : k * 120;
    const outer = radii.length - 1;
    if (k < outer) return angles[k] != null ? angles[k]! : k * 120;
    return (
      (angles[outer] != null ? angles[outer]! : outer * 120) +
      ((k - outer) * 360) / shared
    );
  };
  const orbits = bodies.length
    ? [...new Set(bodies.map((_, k) => radiusOf(k)))].map((r) => ({
        r,
        off: bodies.every((b, k) => radiusOf(k) !== r || !b.online),
      }))
    : [
        { r: radii[0]!, off: true },
        { r: radii[Math.min(2, radii.length - 1)]!, off: true },
      ];
  const dots: {
    key: string;
    bodyKey: string;
    x: number;
    y: number;
    tone: HomeOrbitDotTone;
  }[] = [];
  const moons = bodies.map((body, k) => {
    const r = radiusOf(k);
    const a0 = angleOf(k);
    const [mx, my] = at(r, a0);
    const step = (gap / r) * (180 / Math.PI);
    // Dots trail behind the moon: counter-clockwise on the right half, clockwise on the left.
    const direction = a0 > 90 && a0 < 270 ? 1 : -1;
    body.dots.forEach((dot, i) => {
      const [sx, sy] = at(r, a0 + (i + 1) * step * direction);
      dots.push({
        key: dot.key,
        bodyKey: body.key,
        x: sx,
        y: sy,
        tone: dot.tone,
      });
    });
    return {
      key: body.key,
      x: mx,
      y: my,
      r: o.small ? 3.6 : 4.4,
      off: !body.online,
    };
  });
  const size = pr * 4.2;
  return {
    width: w,
    height: h,
    px,
    py,
    pr,
    orbits,
    moons,
    dots,
    canvas: { left: px - size / 2, top: py - size / 2, size },
  };
}
