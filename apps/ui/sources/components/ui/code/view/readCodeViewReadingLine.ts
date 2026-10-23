import { readDiffLineFromDomNode } from '../diff/diffTextSelection';

/** Where a reader is in the code view: the line the caret should land on and the row at the top of the view. */
export type CodeViewReadingLine = Readonly<{
  /** The selected line when the selection starts in this view, else the top row's line. */
  line: number;
  /** The first visible row and how far its top sits below the viewport's top edge (negative when cut off). */
  top: Readonly<{ line: number; offset: number }>;
}>;

/** The nearest ancestor that scrolls vertically (the code view's own scroller or the page's). */
export function findVerticalScroller(element: HTMLElement): HTMLElement | null {
  let scroller: HTMLElement | null = element;
  while (scroller) {
    const overflow = getComputedStyle(scroller).overflowY;
    if (
      (overflow === 'auto' || overflow === 'scroll') &&
      scroller.scrollHeight > scroller.clientHeight
    )
      return scroller;
    const root = scroller.getRootNode();
    scroller = scroller.parentElement ?? (root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null);
  }
  return null;
}

/**
 * Reads the code view's reading position from its rendered rows (`data-code-line-*`, CodeLinesViewCore) so
 * Edit opens on the same top line, with the caret on the selection (P4-R10). Web only; elsewhere `null`.
 */
export function readCodeViewReadingLine(
  root: unknown,
): CodeViewReadingLine | null {
  if (typeof HTMLElement === 'undefined' || !(root instanceof HTMLElement))
    return null;
  const rows = Array.from(
    root.querySelectorAll<HTMLElement>('[data-code-line-new]'),
  );
  if (rows.length === 0) return null;
  const scroller = findVerticalScroller(rows[0]!);
  const viewport = (scroller ?? root).getBoundingClientRect();
  const first =
    rows.find((row) => row.getBoundingClientRect().bottom > viewport.top) ??
    rows[0]!;
  const topLine = readDiffLineFromDomNode(first)?.newLine;
  if (!topLine) return null;
  const top = {
    line: topLine,
    offset: first.getBoundingClientRect().top - viewport.top,
  };
  const selection =
    typeof window !== 'undefined' ? window.getSelection?.() : null;
  const anchor =
    selection &&
    !selection.isCollapsed &&
    selection.anchorNode &&
    root.contains(selection.anchorNode)
      ? (readDiffLineFromDomNode(
          selection.anchorNode as unknown as Parameters<
            typeof readDiffLineFromDomNode
          >[0],
        )?.newLine ?? null)
      : null;
  return { line: anchor ?? topLine, top };
}
