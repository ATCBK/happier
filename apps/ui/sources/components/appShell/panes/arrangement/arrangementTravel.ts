import { motionTokens } from '@/components/ui/motion/motionTokens';
import { cancelElementRectFlight, captureElementFlightRect, playElementRectFlight, type WindowFlightRect } from '@/components/ui/motion/rectFlight';

/**
 * The arrangement swap's travel (lab ade-shell FL, P1 §3.3): the columns keep their DOM identity
 * (row-reverse), take their new widths in one step, and each slides from where it was to where it
 * now sits as one plane, on the travel spring's duration. The session plane rides above the others
 * while it crosses them; the tool rail cross-fades at its new edge instead of crossing the window.
 * Transform and opacity only, so Monaco, terminals and iframes never reflow per frame. A second press
 * retargets: the start rectangles are read with any running travel included, then that travel is
 * replaced. Reduced motion: one short cross-fade of the whole sheet, no movement.
 */

const TRAVELLING_COLUMN_SELECTOR = [
    '[data-testid="multi-pane-main-column"]',
    '[data-testid="multi-pane-details-docked"]',
    '[data-testid="multi-pane-right-docked"]',
].join(',');
const RAIL_SELECTOR = '[data-testid="pane-action-rail-column"]';

const ANIMATION_ID = 'pane-arrangement-travel';
/** The browser delivers cancellation asynchronously; retargets retain the original resting order. */
const restingZIndex = new WeakMap<HTMLElement, string>();

export type ArrangementTravelStart = Readonly<{ rects: ReadonlyMap<HTMLElement, WindowFlightRect> }>;

function asElement(node: unknown): HTMLElement | null {
    return typeof HTMLElement !== 'undefined' && node instanceof HTMLElement ? node : null;
}

/** Reads where each column is right now (before the new arrangement commits). */
export function captureArrangementTravelStart(hostNode: unknown): ArrangementTravelStart | null {
    const host = asElement(hostNode);
    if (!host) return null;
    const rects = new Map<HTMLElement, WindowFlightRect>();
    host.querySelectorAll<HTMLElement>(TRAVELLING_COLUMN_SELECTOR).forEach((element) => {
        const rect = captureElementFlightRect(element);
        if (rect.width > 0) rects.set(element, rect);
    });
    return { rects };
}

/** Plays the travel from the captured start to the committed layout. */
export function playArrangementTravel(hostNode: unknown, start: ArrangementTravelStart, reducedMotion: boolean): void {
    const host = asElement(hostNode);
    if (!host || typeof host.animate !== 'function') return;
    if (reducedMotion) {
        start.rects.forEach((_, element) => cancelElementRectFlight(element, ANIMATION_ID));
        host.querySelectorAll<HTMLElement>(RAIL_SELECTOR).forEach((rail) => cancelElementRectFlight(rail, ANIMATION_ID));
        cancelElementRectFlight(host, ANIMATION_ID);
        const fade = host.animate([{ opacity: 0.4 }, { opacity: 1 }], {
            duration: motionTokens.overlay.panel.reducedMotionFadeMs, easing: motionTokens.easingCss.standard,
        });
        fade.id = ANIMATION_ID;
        return;
    }
    const durationMs = motionTokens.spring.travel.durationMs;
    cancelElementRectFlight(host, ANIMATION_ID);
    start.rects.forEach((from, element) => {
        const travel = playElementRectFlight(element, from, { animationId: ANIMATION_ID, durationMs, translateOnly: true });
        if (!travel) return;
        const main = element.matches('[data-testid="multi-pane-main-column"]');
        // Only transform is keyframed, so the travel stays on the compositor while the new layout
        // settles on the main thread; the stacking order is a plain style held for the travel.
        if (!restingZIndex.has(element)) restingZIndex.set(element, element.style.zIndex);
        element.style.zIndex = main ? '2' : '1';
        const restoreStacking = () => {
            if (element.getAnimations().some(animation => animation.id === ANIMATION_ID && animation !== travel)) return;
            element.style.zIndex = restingZIndex.get(element) ?? '';
            restingZIndex.delete(element);
        };
        travel.addEventListener('finish', restoreStacking, { once: true });
        travel.addEventListener('cancel', restoreStacking, { once: true });
    });
    host.querySelectorAll<HTMLElement>(RAIL_SELECTOR).forEach((rail) => {
        cancelElementRectFlight(rail, ANIMATION_ID);
        const fade = rail.animate([{ opacity: 0 }, { opacity: 1 }], { duration: durationMs, easing: motionTokens.easingCss.standard });
        fade.id = ANIMATION_ID;
    });
}
