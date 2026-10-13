type Edge = Readonly<{ left: number; right: number }>;

export type ChipRailRevealInput = Readonly<{
    viewportWidth: number;
    /** Edges relative to the rail viewport's left edge (negative: clipped on the leading side). */
    control: Edge;
    previous?: Edge | null;
    next?: Edge | null;
}>;

/**
 * How far to scroll a chip rail (positive: toward the end) so a chip that took focus and its neighbours are
 * whole, never a chip cut mid-word. When the neighbours do not fit with it, the chip alone is made whole.
 */
export function resolveChipRailRevealDelta(input: ChipRailRevealInput): number {
    const { viewportWidth, control } = input;
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
 */
export function attachChipRailReveal(params: AttachChipRailRevealParams): () => void {
    const { node } = params;

    const onScroll = () => params.onScroll();
    const onFocusIn = (event: Event) => {
        const target = event.target as Element | null;
        const control = target?.closest?.(RAIL_CONTROLS) as HTMLElement | null | undefined;
        if (!control || !node.contains(control)) return;
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
            previous: edge(controls[index - 1]),
            next: edge(controls[index + 1]),
        });
        if (delta !== 0) node.scrollLeft += delta;
    };

    node.addEventListener('scroll', onScroll, { passive: true });
    node.addEventListener('focusin', onFocusIn);
    return () => {
        node.removeEventListener('scroll', onScroll);
        node.removeEventListener('focusin', onFocusIn);
    };
}
