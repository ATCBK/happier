import { findVerticalScroller } from './readCodeViewReadingLine';

/** Final landing for a mounted code row, shared by both diff renderers and line navigation. */
export function scrollCodeLineIntoView(
    node: HTMLElement | null,
    block: ScrollLogicalPosition = 'center',
    coveredBottom = 0,
): boolean {
    if (!node || typeof node.scrollIntoView !== 'function') return false;
    const previousMargin = node.style?.scrollMarginBottom;
    try {
        if (coveredBottom > 0) node.style.scrollMarginBottom = `${coveredBottom}px`;
        node.scrollIntoView({ block });
        return true;
    } finally {
        if (coveredBottom > 0) node.style.scrollMarginBottom = previousMargin ?? '';
    }
}

/** Continue a Find landing on real layout changes; the first reader scroll relinquishes it. */
export function retainCodeLineLanding(node: HTMLElement): () => void {
    const scroller = findVerticalScroller(node);
    if (!scroller || typeof ResizeObserver === 'undefined') return () => {};
    const center = () => {
        const rect = node.getBoundingClientRect();
        return rect.top + rect.height / 2 - scroller.getBoundingClientRect().top;
    };
    const landedCenter = center();
    let expectedScrollTop = scroller.scrollTop;
    const stop = () => {
        observer.disconnect();
        scroller.removeEventListener('scroll', onScroll);
        scroller.removeEventListener('wheel', stop);
        scroller.removeEventListener('touchmove', stop);
    };
    const onScroll = () => {
        if (scroller.scrollTop !== expectedScrollTop) stop();
    };
    const observer = new ResizeObserver(() => {
        if (!node.isConnected || scroller.scrollTop !== expectedScrollTop) { stop(); return; }
        const delta = center() - landedCenter;
        if (delta !== 0) scroller.scrollTop += delta;
        expectedScrollTop = scroller.scrollTop;
    });
    // Observe the containing content as well as the row: resizing an earlier row moves this
    // target without changing its own size. Cross Pierre's shadow root to its scroll owner.
    let ancestor: HTMLElement | null = node;
    while (ancestor) {
        observer.observe(ancestor);
        if (ancestor === scroller) break;
        const root = ancestor.getRootNode();
        ancestor = ancestor.parentElement ?? (root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null);
    }
    scroller.addEventListener('scroll', onScroll);
    scroller.addEventListener('wheel', stop, { passive: true });
    scroller.addEventListener('touchmove', stop, { passive: true });
    return stop;
}
