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
  rotate: number;
  style: 'balanced' | 'rich';
  /** One-ink planet (an Agent's identity colour), else the Brand palette. */
  ink?: string;
}>;

export type UsagePlanetSlot = (spec: UsagePlanetSpec) => ReactNode;
