import { useOptionalHappierUiPlatform } from './context.js';

/** The baseline used by iOS and pointer-oriented platform adapters. */
export const HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE = 44;

/** Android's platform requirement is intentionally stricter than the baseline. */
export const HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE = 48;

/**
 * A precise pointer's floor: WCAG 2.2 AA target size (2.5.8). Dense pointer layouts keep their
 * drawn sizes above it; the touch floors above apply only where the primary pointer is a finger.
 */
export const HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE = 24;

/**
 * The one 44/48 platform policy shared by Happier core adapters and portable
 * presentation. Callers that render dense desktop/web layouts can retain their
 * density by using {@link useHappierNativeMinimumInteractiveTargetSize}, which
 * deliberately applies a physical floor only to native touch platforms.
 */
export function resolveHappierMinimumInteractiveTargetSize(platform: string): 44 | 48 {
  return platform === 'android'
    ? HAPPIER_ANDROID_MINIMUM_INTERACTIVE_TARGET_SIZE
    : HAPPIER_DEFAULT_MINIMUM_INTERACTIVE_TARGET_SIZE;
}

/**
 * Combine an explicit host-requested physical target with the only factual
 * platform floor. Undefined on web/desktop deliberately preserves dense
 * pointer layouts instead of inventing a native touch platform.
 */
export function resolveHappierInteractiveTargetFloor(
  requested: number | undefined,
  nativeMinimum: number | undefined,
): number | undefined {
  const requestedFloor = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.max(0, requested)
    : 0;
  const floor = Math.max(requestedFloor, nativeMinimum ?? 0);
  return floor > 0 ? floor : undefined;
}

/**
 * Reads the mounted provider's platform fact and returns a physical touch floor
 * only where that fact denotes a native touch platform. `undefined` preserves
 * desktop/web density and the behavior of an environment-free core adapter;
 * neither path fabricates a platform fact.
 */
export function useHappierNativeMinimumInteractiveTargetSize(): 44 | 48 | undefined {
  const platform = useOptionalHappierUiPlatform()?.platform;
  return platform === 'android' || platform === 'ios'
    ? resolveHappierMinimumInteractiveTargetSize(platform)
    : undefined;
}

let coarsePrimaryPointer: boolean | null = null;

function matchesMedia(query: string): boolean {
  const match = (globalThis as { matchMedia?: (query: string) => { matches?: boolean } | null }).matchMedia;
  if (typeof match !== 'function') return false;
  try {
    return match.call(globalThis, query)?.matches === true;
  } catch {
    return false;
  }
}

/**
 * Whether a browser's PRIMARY pointer is a finger (a phone or tablet browser). Only `pointer:` and
 * `hover:` describe the primary pointer: a hover-capable laptop that merely has a touchscreen keeps
 * its precise-pointer density. Read once: the primary pointer does not change under a running app.
 */
export function isHappierCoarsePrimaryPointer(): boolean {
  if (coarsePrimaryPointer !== null) return coarsePrimaryPointer;
  let coarse: boolean;
  if (matchesMedia('(pointer: fine)') || matchesMedia('(hover: hover)')) coarse = false;
  else if (matchesMedia('(pointer: coarse)') || matchesMedia('(hover: none)')) coarse = true;
  else {
    const touchPoints = (globalThis as { navigator?: { maxTouchPoints?: unknown } }).navigator?.maxTouchPoints;
    coarse = typeof touchPoints === 'number' && touchPoints > 0;
  }
  coarsePrimaryPointer = coarse;
  return coarse;
}

/** @internal Tests switch the emulated primary pointer between mounts. */
export function resetHappierPrimaryPointerForTesting(): void {
  coarsePrimaryPointer = null;
}

/**
 * Whether the primary pointer is a finger: always on a native touch platform, and in a browser whose
 * primary pointer cannot hover (a phone or tablet). Density choices that differ by pointer (row
 * heights, page sizes, drag handles) and the hit-area policy below ask this one fact.
 */
export function isHappierTouchPrimaryPointer(platform: string | undefined): boolean {
  return platform === 'android' || platform === 'ios' || isHappierCoarsePrimaryPointer();
}

/**
 * The hit area a finger needs here: 44 (48 on Android) on a native touch platform and in a browser
 * whose primary pointer is a finger, `undefined` under a precise pointer, whose dense layout keeps its
 * own target. It sizes the HIT AREA only; a control keeps its drawn size
 * ({@link resolveHappierHitInsets}).
 */
export function useHappierTouchTargetSize(): 44 | 48 | undefined {
  const platform = useOptionalHappierUiPlatform()?.platform;
  return isHappierTouchPrimaryPointer(platform) ? resolveHappierMinimumInteractiveTargetSize(platform ?? 'web') : undefined;
}

/**
 * How far a control's hit area may reach past its drawn box on each side: half the gap to the
 * neighbouring control, or the free space to a container edge that clips. A number applies to every
 * side; an omitted side may reach as far as the target needs. `0` keeps that side at the drawn edge.
 */
export type HappierHitReach = number | Readonly<{ top?: number; bottom?: number; left?: number; right?: number }>;

export type HappierHitInsets = Readonly<{ top: number; bottom: number; left: number; right: number }>;

function reachOf(reach: HappierHitReach | undefined, side: keyof HappierHitInsets): number {
  const value = typeof reach === 'number' ? reach : reach?.[side];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : Number.POSITIVE_INFINITY;
}

/**
 * The one hit-area policy: how far beyond a control's DRAWN box its hit area extends so the area
 * reaches `target`, centred on the control and never past the reach it was given. The drawn box and
 * its layout never grow; neighbours that each reach half their gap meet without overlapping. An
 * unknown drawn dimension extends nothing on that axis. `undefined` when nothing extends.
 */
export function resolveHappierHitInsets(input: Readonly<{
  width?: number;
  height?: number;
  target: number | undefined;
  reach?: HappierHitReach;
}>): HappierHitInsets | undefined {
  const { target } = input;
  if (target === undefined || !Number.isFinite(target)) return undefined;
  const deficit = (drawn: number | undefined) => (
    typeof drawn === 'number' && Number.isFinite(drawn) ? Math.max(0, (target - drawn) / 2) : 0
  );
  const x = deficit(input.width);
  const y = deficit(input.height);
  const insets = {
    top: Math.min(y, reachOf(input.reach, 'top')),
    bottom: Math.min(y, reachOf(input.reach, 'bottom')),
    left: Math.min(x, reachOf(input.reach, 'left')),
    right: Math.min(x, reachOf(input.reach, 'right')),
  };
  return insets.top + insets.bottom + insets.left + insets.right > 0 ? insets : undefined;
}
