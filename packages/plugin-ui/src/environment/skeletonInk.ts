/**
 * The one decision for loading-placeholder ink: the theme's own text ink at a quiet, fixed strength. Under the
 * skeleton pulse (`HAPPIER_SKELETON_PULSE_V1`, 0.4–0.8 opacity) the bars stay plainly visible on every page,
 * sheet and inset in light and dark without competing with content. The host derives its `surface.skeleton`
 * default from this strength; a realm with only the public theme snapshot (a hosted-web frame) resolves the
 * same ink from the snapshot's text colour.
 */
export const HAPPIER_SKELETON_INK_ALPHA = 0.16;

const HEX6 = /^#([0-9a-fA-F]{6})$/;

/** The skeleton ink for a `#RRGGBB` text colour; `null` when it is not a solid hex colour. */
export function resolveHappierSkeletonInk(text: string): string | null {
  const hex = HEX6.exec(text.trim());
  if (!hex) return null;
  const value = parseInt(hex[1]!, 16);
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${HAPPIER_SKELETON_INK_ALPHA})`;
}
