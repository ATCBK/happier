import { END_INDICATOR_ROOM_PX } from './resolveChipRailCutEdges';

type Edge = Readonly<{ left: number; right: number }>;

export type ChipRailRevealInput = Readonly<{
    viewportWidth: number;
    /** Edges relative to the rail viewport's left edge (negative: clipped on the leading side). */
    control: Edge;
    previous?: Edge | null;
    next?: Edge | null;
    /** Trailing room the rail's scroll indicator covers; a chip ending inside it is cut by the rail mask. */
    endIndicatorRoom?: number;
}>;

/**
 * How far to scroll a chip rail (positive: toward the end) so a chip that took focus and its neighbours are
 * whole, never a chip cut mid-word. When the neighbours do not fit with it, the chip alone is made whole.
 */
export function resolveChipRailRevealDelta(input: ChipRailRevealInput): number {
    const { control } = input;
    const viewportWidth = input.viewportWidth - (input.endIndicatorRoom ?? 0);
    const lo = Math.min(control.left, input.previous?.left ?? control.left);
    const hi = Math.max(control.right, input.next?.right ?? control.right);
    if (hi - lo <= viewportWidth) {
        if (lo < 0) return lo;
        return hi > viewportWidth ? hi - viewportWidth : 0;
    }
    if (control.left < 0) return control.left;
    // A control wider than the rail keeps its leading edge visible.
    return control.right > viewportWidth ? Math.min(control.right - viewportWidth, control.left) : 0;
}

const RAIL_CONTROLS = 'button,[role="button"],[role="switch"]';

export type AttachChipRailRevealParams = Readonly<{
    node: HTMLElement;
    /** The rail's edge fades are derived from its scroll position: report every change of it. */
    onScroll: () => void;
}>;

/**
 * The web behaviour every composer chip rail shares. The rail reports its own DOM scroll (React Native
 * Web's throttled `onScroll` can drop the final position of a smooth or programmatic scroll, leaving an
 * edge fade stale), and a chip that takes focus (a click, Tab, the arrow keys) scrolls the rail so that
 * chip and its neighbours are whole. The scroll is instant: a popover opened by the click measures its chip
 * after focus, so the rail must not still be moving.
 *
 * A pointer press focuses its chip on press, but a click needs the press and the release on the same chip:
 * a rail that scrolls in between puts another chip under the pointer and the click is lost. So a pointer
 * focus reveals on release, before the click is delivered, and not at all when the person dragged the rail.
 * The person is looking at the chip they pressed, so only that chip is made whole, not its neighbours:
 * a press on a whole chip leaves the rail where it rests.
 */
export function attachChipRailReveal(params: AttachChipRailRevealParams): () => void {
    const { node } = params;
    const doc = node.ownerDocument;

    const onScroll = () => params.onScroll();
    const reveal = (control: HTMLElement, withNeighbours: boolean) => {
        const controls = Array.from(node.querySelectorAll<HTMLElement>(RAIL_CONTROLS));
        const index = controls.indexOf(control);
        if (index < 0) return;
        const rail = node.getBoundingClientRect();
        const edge = (element: HTMLElement | undefined): Edge | null => {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { left: rect.left - rail.left, right: rect.right - rail.left };
        };
        const delta = resolveChipRailRevealDelta({
            viewportWidth: node.clientWidth || rail.width,
            control: edge(control)!,
            previous: withNeighbours ? edge(controls[index - 1]) : null,
            next: withNeighbours ? edge(controls[index + 1]) : null,
            endIndicatorRoom: END_INDICATOR_ROOM_PX,
        });
        if (delta !== 0) node.scrollLeft += delta;
    };

    let press: Readonly<{ scrollLeft: number; focused: HTMLElement | null }> | null = null;
    const onPointerRelease = () => {
        doc.removeEventListener('pointerup', onPointerRelease, true);
        doc.removeEventListener('pointercancel', onPointerRelease, true);
        const pressed = press;
        press = null;
        // The rail only moved under the press when the person dragged it: leave it where it was dropped.
        if (pressed?.focused && pressed.scrollLeft === node.scrollLeft) reveal(pressed.focused, false);
    };
    const onPointerDown = () => {
        press = { scrollLeft: node.scrollLeft, focused: null };
        doc.addEventListener('pointerup', onPointerRelease, true);
        doc.addEventListener('pointercancel', onPointerRelease, true);
    };
    const onFocusIn = (event: Event) => {
        const target = event.target as Element | null;
        const control = target?.closest?.(RAIL_CONTROLS) as HTMLElement | null | undefined;
        if (!control || !node.contains(control)) return;
        if (press) {
            press = { ...press, focused: control };
            return;
        }
        reveal(control, true);
    };

    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('pointerdown', onPointerDown, true);
    node.addEventListener('focusin', onFocusIn);
    return () => {
        node.removeEventListener('scroll', onScroll);
        node.removeEventListener('pointerdown', onPointerDown, true);
        node.removeEventListener('focusin', onFocusIn);
        doc.removeEventListener('pointerup', onPointerRelease, true);
        doc.removeEventListener('pointercancel', onPointerRelease, true);
    };
}
