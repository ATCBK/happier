import { motionTokens } from '@/components/ui/motion/motionTokens';

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

/** Each travelling column's own stacking order, put back when its travel lands. */
const restingZIndex = new WeakMap<HTMLElement, string>();

export type ArrangementTravelStart = Readonly<{ rects: ReadonlyMap<HTMLElement, DOMRect> }>;

function asElement(node: unknown): HTMLElement | null {
    return typeof HTMLElement !== 'undefined' && node instanceof HTMLElement ? node : null;
}

/** Reads where each column is right now (before the new arrangement commits). */
export function captureArrangementTravelStart(hostNode: unknown): ArrangementTravelStart | null {
    const host = asElement(hostNode);
    if (!host) return null;
    const rects = new Map<HTMLElement, DOMRect>();
    host.querySelectorAll<HTMLElement>(TRAVELLING_COLUMN_SELECTOR).forEach((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0) rects.set(element, rect);
    });
    return { rects };
}

function cancelTravel(element: HTMLElement): void {
    for (const animation of element.getAnimations?.() ?? []) {
        if ((animation as Animation & { id?: string }).id === 'pane-arrangement-travel') animation.cancel();
    }
}

/** Plays the travel from the captured start to the committed layout. */
export function playArrangementTravel(hostNode: unknown, start: ArrangementTravelStart, reducedMotion: boolean): void {
    const host = asElement(hostNode);
    if (!host || typeof host.animate !== 'function') return;
    if (reducedMotion) {
        cancelTravel(host);
        const fade = host.animate([{ opacity: 0.4 }, { opacity: 1 }], {
            duration: motionTokens.overlay.panel.reducedMotionFadeMs, easing: motionTokens.easingCss.standard,
        });
        (fade as Animation & { id: string }).id = 'pane-arrangement-travel';
        return;
    }
    const durationMs = motionTokens.spring.travel.durationMs;
    start.rects.forEach((from, element) => {
        if (!element.isConnected) return;
        cancelTravel(element);
        const to = element.getBoundingClientRect();
        const dx = from.left - to.left;
        if (Math.abs(dx) < 1 || to.width === 0) return;
        const main = element.matches('[data-testid="multi-pane-main-column"]');
        // Only transform is keyframed, so the travel stays on the compositor while the new layout
        // settles on the main thread; the stacking order is a plain style held for the travel.
        if (!restingZIndex.has(element)) restingZIndex.set(element, element.style.zIndex);
        element.style.zIndex = main ? '2' : '1';
        const travel = element.animate(
            [{ transform: `translateX(${dx}px)` }, { transform: 'translateX(0px)' }],
            { duration: durationMs, easing: motionTokens.easingCss.standard },
        );
        (travel as Animation & { id: string }).id = 'pane-arrangement-travel';
        // A retargeted travel replaces this one; only the last one to finish puts the order back.
        travel.addEventListener('finish', () => {
            if (element.getAnimations().some(animation => (animation as Animation & { id?: string }).id === 'pane-arrangement-travel' && animation !== travel)) return;
            element.style.zIndex = restingZIndex.get(element) ?? '';
            restingZIndex.delete(element);
        });
    });
    host.querySelectorAll<HTMLElement>(RAIL_SELECTOR).forEach((rail) => {
        cancelTravel(rail);
        const fade = rail.animate([{ opacity: 0 }, { opacity: 1 }], { duration: durationMs, easing: motionTokens.easingCss.standard });
        (fade as Animation & { id: string }).id = 'pane-arrangement-travel';
    });
}
