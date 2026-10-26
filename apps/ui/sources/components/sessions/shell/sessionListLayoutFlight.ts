import type { SessionListLayoutChoice } from '@/sync/domains/session/listing/sessionListLayout';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import {
  captureElementFlightRect,
  playElementRectFlight,
  type WindowFlightRect,
} from '@/components/ui/motion/rectFlight';

/**
 * Projects ↔ Recent (P5 §6, lab `clviews`): the rows the person was looking at glide to where the other layout
 * puts them, instead of the list redrawing under them. The choice captures the visible rows once, before it is
 * written; the list plays once, after it commits the layout that was captured for. A row keeps its key across
 * layouts (its base occurrence), so it travels; a header or row the new layout adds fades in. Transform and
 * opacity only, from the shared rect-flight owner; nothing is measured off screen and nothing runs after it
 * settles. Web only: a native list switches in place.
 *
 * A drop that files a row (P5 §6 committed placement) is the same flight: the carry captures where the rows
 * stand as the move is dispatched, and the next committed list, which already shows the filing, glides them there.
 */
export const SESSION_LIST_FLIGHT_ATTRIBUTE = 'data-session-list-flight';
const FLIGHT_ID = 'session-list-layout';

type PendingFlight = Readonly<{
  /** The layout the choice captured for; a drop's placement is not tied to a layout. */
  layout: SessionListLayoutChoice | null;
  rects: ReadonlyMap<string, WindowFlightRect>;
}>;

let pending: PendingFlight | null = null;

function flightElements(): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      `[${SESSION_LIST_FLIGHT_ATTRIBUTE}]`,
    ),
  );
}

function visible(rect: WindowFlightRect): boolean {
  const viewportHeight =
    typeof window === 'undefined' ? Infinity : window.innerHeight || Infinity;
  return rect.height > 0 && rect.y + rect.height > 0 && rect.y < viewportHeight;
}

/** Captures where the visible rows stand, for the layout about to be chosen. */
export function captureSessionListLayoutFlight(
  layout: SessionListLayoutChoice,
): void {
  const rects = captureVisibleRects();
  pending = rects.size > 0 ? { layout, rects } : null;
}

function captureVisibleRects(): Map<string, WindowFlightRect> {
  const rects = new Map<string, WindowFlightRect>();
  for (const element of flightElements()) {
    const key = element.getAttribute(SESSION_LIST_FLIGHT_ATTRIBUTE);
    const rect = captureElementFlightRect(element);
    if (key && visible(rect)) rects.set(key, rect);
  }
  return rects;
}

/** Captures where the visible rows stand as a drop's move is dispatched; the next committed list glides from it. */
export function captureSessionListPlacementFlight(): void {
  const rects = captureVisibleRects();
  pending = rects.size > 0 ? { layout: null, rects } : null;
}

/** Whether a chosen layout is waiting to glide; the list checks this before scheduling anything. */
export function hasPendingSessionListLayoutFlight(): boolean {
    return pending !== null;
}

/** The chosen layout was not applied: nothing will glide. */
export function cancelSessionListLayoutFlight(): void {
  pending = null;
}

/** Plays the captured flight once the list has committed `layout`. */
export function playSessionListLayoutFlight(
  layout: SessionListLayoutChoice,
): void {
  const flight = pending;
  if (!flight || (flight.layout !== null && flight.layout !== layout)) return;
  pending = null;
  for (const element of flightElements()) {
    const key = element.getAttribute(SESSION_LIST_FLIGHT_ATTRIBUTE);
    if (!key) continue;
    const origin = flight.rects.get(key);
    if (origin) {
      playElementRectFlight(element, origin, {
        animationId: FLIGHT_ID,
        durationMs: motionTokens.durationMs.base,
        translateOnly: true,
      });
      continue;
    }
    if (
      typeof element.animate !== 'function' ||
      !visible(captureElementFlightRect(element))
    )
      continue;
    element.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: motionTokens.durationMs.base,
      easing: motionTokens.easingCss.standard,
    });
  }
}
