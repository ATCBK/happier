import type { ReactNode } from 'react';

/**
 * The Brand planet a chart places, described by its data-driven inputs only. The host draws it with its own Brand
 * owner (the app's planet canvas, the server's static adapter); a body never paints planet geometry itself.
 */
export type UsagePlanetSpec = Readonly<{
  /** Square box, CSS px. */
  size: number;
  /** Planet radius inside the box. */
  radius: number;
  /** 0–1: the outer glow. */
  halo: number;
  /** 0–1: the trail behind the planet. */
  tail: number;
  /** 0–1: how lit the planet is. */
  rise: number;
  /** 0–1: how much of the night side shows as a soft terminator shade, so a barely lit planet still reads whole. Absent = none. */
  night?: number;
  rotate: number;
  style: 'balanced' | 'rich';
  /** One-ink planet (an Agent's identity colour), else the Brand palette. */
  ink?: string;
  /** 0–1: the planet's phase (the Brand light for that progress: 0 a sliver, 1 fully lit). Absent = the Brand default light. */
  light?: number;
  /** A small phase mark filling the box on the Brand mark lattice (radius, tail and rotate do not apply). */
  mark?: boolean;
  /**
   * Data painted onto the surface: the planet's own dot lattice in vertical bands, left to right, each band's
   * dots weighted 0–1 (a dim band is a quiet day). Absent = the plain planet.
   */
  meridians?: readonly number[];
}>;

export type UsagePlanetSlot = (spec: UsagePlanetSpec) => ReactNode;

/** Dots dimmer than this are left out of a meridian-painted planet (a rest day reads as dark surface, not as gaps). */
const MERIDIAN_FLOOR = 0.06;

/**
 * The one rule every host applies to paint `meridians` onto its Brand planet: the weight of the band a body dot at
 * `x` sits in. Hosts multiply that dot's opacity by it and leave the planet's own haze out.
 */
export function usagePlanetMeridianWeight(
  spec: UsagePlanetSpec,
  x: number,
): number {
  const bands = spec.meridians;
  if (!bands?.length) return 1;
  const left = spec.size / 2 - spec.radius;
  const band = Math.max(
    0,
    Math.min(
      bands.length - 1,
      Math.floor(((x - left) / (2 * spec.radius)) * bands.length),
    ),
  );
  return Math.max(MERIDIAN_FLOOR, Math.min(1, bands[band] ?? 0));
}
