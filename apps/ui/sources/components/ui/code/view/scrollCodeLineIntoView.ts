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
