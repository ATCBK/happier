import type { View } from 'react-native';

/** A rectangle in window coordinates. */
export type WindowRect = Readonly<{
  x: number;
  y: number;
  w: number;
  h: number;
}>;

type SessionKey = Readonly<{
  serverId: string | null | undefined;
  sessionId: string;
}>;

/**
 * Where a Bot's picture was when the person chose Pin to rail (lab `b-rail` signature move, plan 60
 * motion: "pin shared-element flight"). The row that offered the action writes it; the rail slot that
 * appears once the pin is accepted reads it and travels from there. Nothing else reads it, and a
 * refused pin forgets it, so a later pin from elsewhere never flies from a stale row.
 */
const origins = new Map<string, WindowRect>();

function keyOf(session: SessionKey): string {
  return `${session.serverId ?? ''}\u0000${session.sessionId}`;
}

export function noteRailPinOrigin(
  session: SessionKey,
  rect: WindowRect | null,
): void {
  if (rect && rect.w > 0 && rect.h > 0) origins.set(keyOf(session), rect);
  else origins.delete(keyOf(session));
}

export function forgetRailPinOrigin(session: SessionKey): void {
  origins.delete(keyOf(session));
}

/** Read without consuming (render may run twice); the landing slot forgets it once it has started. */
export function peekRailPinOrigin(session: SessionKey): WindowRect | null {
  return origins.get(keyOf(session)) ?? null;
}

/** The view's window rectangle, or `null` when it cannot be read. */
export function measureWindowRect(
  view: View | null | undefined,
): Promise<WindowRect | null> {
  if (!view || typeof view.measureInWindow !== 'function')
    return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      view.measureInWindow((x, y, w, h) =>
        resolve(
          Number.isFinite(x) && Number.isFinite(y) ? { x, y, w, h } : null,
        ),
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * The landing slot's starting transform: centred on the picture it left, at that picture's size.
 * `null` when there is nothing to travel (no origin, an unmeasured slot).
 */
export function resolveRailPinFlightStart(
  origin: WindowRect | null,
  slot: WindowRect | null,
): Readonly<{ translateX: number; translateY: number; scale: number }> | null {
  if (!origin || !slot || slot.w <= 0 || slot.h <= 0) return null;
  return {
    translateX: origin.x + origin.w / 2 - (slot.x + slot.w / 2),
    translateY: origin.y + origin.h / 2 - (slot.y + slot.h / 2),
    scale: origin.w / slot.w,
  };
}
