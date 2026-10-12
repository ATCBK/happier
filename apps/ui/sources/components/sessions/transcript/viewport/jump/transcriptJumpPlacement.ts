import type { TranscriptViewportJumpAlignment } from '../transcriptViewportTypes';

/**
 * Where a jump target's item sits in the viewport once placed: centred, or its top at a
 * fixed offset from the viewport top (negative when a focus inside a tall item must show).
 */
export type TranscriptJumpPlacement =
  | Readonly<{ kind: 'center' }>
  | Readonly<{ kind: 'item-offset'; itemOffsetPx: number }>;

/**
 * The one geometry decision for every jump alignment, shared by the drivers, the landing
 * check and the renderer approach. `focusTopPx` is the mounted focus element's top within
 * the item; it is absent until the item is mounted.
 */
export function resolveTranscriptJumpPlacement(
  input: Readonly<{
    align: TranscriptViewportJumpAlignment;
    itemHeight: number | null;
    viewportHeight: number;
    focusTopPx?: number | null;
  }>,
): TranscriptJumpPlacement {
  const { align } = input;
  if (align.kind === 'center') return { kind: 'center' };
  if (align.kind === 'top-with-item-offset')
    return { kind: 'item-offset', itemOffsetPx: align.itemOffsetPx };
  // Reveal: an item that fits below the clearance starts right under it; a taller one
  // places its mounted focus there and approaches centred until then. Without a top
  // clearance (the phone's seated Find bar) a fitting row keeps the centred landing.
  const fits =
    input.itemHeight !== null &&
    input.itemHeight + align.clearancePx <= input.viewportHeight;
  if (
    !fits &&
    typeof input.focusTopPx === 'number' &&
    Number.isFinite(input.focusTopPx)
  ) {
    return {
      kind: 'item-offset',
      itemOffsetPx: align.clearancePx - input.focusTopPx,
    };
  }
  if (fits && align.clearancePx > 0)
    return { kind: 'item-offset', itemOffsetPx: align.clearancePx };
  return { kind: 'center' };
}

/** Item offset from the viewport top implied by a placement for an item of this height. */
export function resolveTranscriptJumpPlacementItemOffset(
  placement: TranscriptJumpPlacement,
  itemHeight: number,
  viewportHeight: number,
): number {
  return placement.kind === 'center'
    ? viewportHeight / 2 - Math.max(0, itemHeight) / 2
    : placement.itemOffsetPx;
}

type RectElement = Pick<Element, 'getBoundingClientRect'> &
  Partial<Pick<Element, 'querySelectorAll'>>;

/**
 * Web: the placement of a MOUNTED item, measured from the DOM — the item rect and, for a
 * reveal, its first visible focus element. Returns the scroll offset that realizes it.
 */
export function resolveWebTranscriptJumpTargetScrollTop(
  input: Readonly<{
    align: TranscriptViewportJumpAlignment;
    item: RectElement;
    scroller: Pick<Element, 'getBoundingClientRect'>;
    scrollTop: number;
    clientHeight: number;
  }>,
): Readonly<{ targetScrollTop: number; itemOffsetPx: number }> | null {
  const scrollerRect = input.scroller.getBoundingClientRect();
  const itemRect = input.item.getBoundingClientRect();
  const itemTop = itemRect.top - scrollerRect.top;
  const itemHeight = Number.isFinite(itemRect.height)
    ? Math.max(0, itemRect.height)
    : Math.max(0, itemRect.bottom - itemRect.top);
  const placement = resolveTranscriptJumpPlacement({
    align: input.align,
    itemHeight,
    viewportHeight: input.clientHeight,
    focusTopPx:
      input.align.kind === 'reveal'
        ? readWebFocusTop(input.item, input.align.focusTestId, itemRect.top)
        : null,
  });
  const itemOffsetPx = resolveTranscriptJumpPlacementItemOffset(
    placement,
    itemHeight,
    input.clientHeight,
  );
  const targetScrollTop = input.scrollTop + itemTop - itemOffsetPx;
  if (!Number.isFinite(targetScrollTop)) return null;
  return { targetScrollTop, itemOffsetPx };
}

function readWebFocusTop(
  item: RectElement,
  focusTestId: string | undefined,
  itemTop: number,
): number | null {
  if (!focusTestId || typeof item.querySelectorAll !== 'function') return null;
  let top: number | null = null;
  for (const node of item.querySelectorAll(`[data-testid="${focusTestId}"]`)) {
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) continue;
    const visibleTop = clampToClippingAncestors(node, item, rect.top, rect.height);
    if (top === null || visibleTop < top) top = visibleTop;
  }
  return top === null ? null : top - itemTop;
}

/**
 * A focus inside a row's own scroller (a long tool output) sits where that scroller shows
 * it; the row-local reveal scrolls the inner content. The transcript places the scroller's
 * visible edge, never a point thousands of pixels past the row's own box.
 */
function clampToClippingAncestors(node: Element, item: RectElement, top: number, height: number): number {
  const view = node.ownerDocument?.defaultView;
  if (!view) return top;
  let clamped = top;
  for (let ancestor = node.parentElement; ancestor && ancestor !== item; ancestor = ancestor.parentElement) {
    if (ancestor.scrollHeight <= ancestor.clientHeight) continue;
    const overflow = view.getComputedStyle(ancestor).overflowY;
    if (overflow === 'visible') continue;
    const box = ancestor.getBoundingClientRect();
    clamped = Math.min(Math.max(clamped, box.top), Math.max(box.top, box.bottom - height));
  }
  return clamped;
}
