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
  /** A ring scene's marks and their tethers (`layoutHomeOrbitRing`); absent on an orbit scene. */
  ring?: HomeOrbitRing;
}>;

/**
 * How a mark on the ring reaches the Home: `account` held by the Home itself (a solid tether), `machine`
 * run on the machines (dotted), `attention` waiting on the person (amber dashed, with a beacon), `none`
 * not reaching anything (no tether, the mark faded).
 */
export type HomeOrbitTether = 'account' | 'machine' | 'attention' | 'none';

export type HomeOrbitRingMark = Readonly<{
  key: string;
  tether: HomeOrbitTether;
  /** Drawn faded; by default a mark with no tether is (a count mark like "+2" is not). */
  faded?: boolean;
}>;

export type HomeOrbitRing = Readonly<{
  r: number;
  /** A mark's drawn box (its centre is on the ring). */
  markSize: number;
  marks: readonly Readonly<{
    key: string;
    tether: HomeOrbitTether;
    faded: boolean;
    x: number;
    y: number;
    /** The tether: from just outside the planet's glow to just inside the mark. */
    from: Readonly<{ x: number; y: number }>;
    to: Readonly<{ x: number; y: number }>;
  }>[];
}>;

export type HomeOrbitRingOptions = Readonly<{
  pr?: number;
  px?: number;
  py?: number;
  /** The ring's radius; raised when needed so a mark never sits inside the planet's glow. */
  r?: number;
  /** The first mark's angle, in degrees (the top). */
  startAngle?: number;
  markSize?: number;
}>;

/**
 * The ring scene (lab hm-A `tetherMap`): one dotted ring around the planet and N marks spaced evenly on
 * it, the first at the top, each with its tether toward the planet. The glow is the planet canvas's
 * half-size (2.1 planet radii); the ring keeps every mark wholly outside it.
 */
export function layoutHomeOrbitRing(
  w: number,
  h: number,
  marks: readonly HomeOrbitRingMark[],
  o: HomeOrbitRingOptions = {},
): HomeOrbitScene {
  const pr = Math.round(o.pr || Math.min(h, w) * 0.13);
  const px = Math.round(o.px != null ? o.px : w / 2),
    py = Math.round(o.py != null ? o.py : h / 2);
  const markSize = o.markSize ?? 22;
  const glow = pr * 2.1;
  const r = Math.round(Math.max(o.r ?? pr * 2.9, glow + markSize / 2 + 2));
  const a0 = o.startAngle ?? -90;
  const at = (radius: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return { x: px + Math.cos(a) * radius, y: py + Math.sin(a) * radius };
  };
  const placed = marks.map((mark, index) => {
    const deg = a0 + (360 / Math.max(1, marks.length)) * index;
    const centre = at(r, deg);
    return {
      key: mark.key,
      tether: mark.tether,
      faded: mark.faded ?? mark.tether === 'none',
      x: centre.x,
      y: centre.y,
      from: at(pr + 13, deg),
      to: at(r - markSize / 2 - 3, deg),
    };
  });
  const size = pr * 4.2;
  return {
    width: w,
    height: h,
    px,
    py,
    pr,
    orbits: [{ r, off: marks.length === 0 }],
    moons: [],
    dots: [],
    canvas: { left: px - size / 2, top: py - size / 2, size },
    ring: { r, markSize, marks: placed },
  };
}

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

/** Inter's average advance at the meta size, as a share of the font size: enough to keep a label inside the map. */
const LABEL_ADVANCE_EM = 0.56;
const LABEL_GAP_PX = 6;

/**
 * A moon's name sits on the side with room: after the moon, or before it when the map's edge is
 * closer than the name. On the planet's row the side facing the planet only reaches the planet's
 * edge, so a name never runs across it. A name longer than its room ends in an ellipsis, and a
 * same-name machine's suffix ("Build box · 08cc") stays whole while the name before it shortens.
 */
export function placeOrbitMoonLabel(
  moon: Readonly<{ x: number; y: number; r: number }>,
  label: string,
  area: Readonly<{ width: number; px: number; py: number; pr: number }>,
  fontSize: number,
): Readonly<{ x: number; textAnchor: 'start' | 'end'; text: string }> {
  const advance = fontSize * LABEL_ADVANCE_EM;
  const onPlanetRow = Math.abs(moon.y - area.py) < area.pr + fontSize;
  // A name keeps a gap from the map's edge and from the planet, so a wide glyph never clips.
  const afterEdge = (onPlanetRow && moon.x < area.px ? area.px - area.pr : area.width) - LABEL_GAP_PX;
  const beforeEdge = (onPlanetRow && moon.x > area.px ? area.px + area.pr : 0) + LABEL_GAP_PX;
  const after = afterEdge - (moon.x + moon.r + LABEL_GAP_PX);
  const before = moon.x - moon.r - LABEL_GAP_PX - beforeEdge;
  const needed = label.length * advance;
  const useAfter = needed <= after || after >= before;
  const room = Math.max(0, useAfter ? after : before);
  const text = fitMoonLabel(label, Math.max(1, Math.floor(room / advance)));
  return useAfter
    ? { x: Math.round((moon.x + moon.r + LABEL_GAP_PX) * 10) / 10, textAnchor: 'start', text }
    : { x: Math.round((moon.x - moon.r - LABEL_GAP_PX) * 10) / 10, textAnchor: 'end', text };
}

/** Shortens a label to `fits` characters, keeping a trailing " · suffix" whole when it leaves room for a name. */
function fitMoonLabel(label: string, fits: number): string {
  if (label.length <= fits) return label;
  const tail = label.lastIndexOf(' · ');
  const suffix = tail > 0 ? label.slice(tail) : '';
  if (suffix && fits - suffix.length >= 3) return `${label.slice(0, fits - suffix.length - 1)}…${suffix}`;
  return `${label.slice(0, Math.max(1, fits - 1))}…`;
}
