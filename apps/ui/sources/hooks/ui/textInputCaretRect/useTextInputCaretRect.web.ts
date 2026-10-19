import * as React from 'react';
import getCaretCoordinates from 'textarea-caret';

import type {
    CaretRect,
    UseTextInputCaretRectInput,
} from './useTextInputCaretRect.types';

export type { CaretRect, TextInputCaretRectHandle, UseTextInputCaretRectInput } from './useTextInputCaretRect.types';

/**
 * Pure, unit-testable math: transforms textarea-local caret coordinates
 * into viewport-relative coordinates using the element's bounding rect
 * and scroll offsets.
 *
 * Per D47: uses viewport/client coordinates (no window.scrollX/Y addition).
 * Per D39: this is the jsdom-safe test target; real textarea-caret is Playwright-validated.
 */
export function computeWebCaretRect(
    elRect: Readonly<{ left: number; top: number }>,
    elScroll: Readonly<{ left: number; top: number }>,
    caret: Readonly<{ left: number; top: number; height: number }>,
): CaretRect {
    return {
        left: elRect.left + caret.left - elScroll.left,
        top: elRect.top + caret.top - elScroll.top,
        height: caret.height,
    };
}

/**
 * Cross-platform caret-rect hook (web implementation).
 *
 * Uses `textarea-caret` to measure caret position in a `<textarea>` element,
 * then transforms to viewport-relative coordinates.
 *
 * Returns `null` while disabled, before first measurement, or when the textarea
 * ref is unavailable.
 */
export function useTextInputCaretRect(input: UseTextInputCaretRectInput): CaretRect | null {
    const { inputRef, selection, enabled = true } = input;

    const [rect, setRect] = React.useState<CaretRect | null>(null);

    // Recompute on selection, value, or enabled changes.
    React.useEffect(() => {
        if (!enabled) {
            setRect(null);
            return;
        }

        const el = inputRef.current?.getInputElement();
        if (el == null) {
            setRect(null);
            return;
        }

        const selectionStart = selection?.start ?? 0;

        const measure = () => {
            const caretCoords = getCaretCoordinates(el, selectionStart);
            const elRect = el.getBoundingClientRect();

            const next = computeWebCaretRect(
                { left: elRect.left, top: elRect.top },
                { left: el.scrollLeft, top: el.scrollTop },
                caretCoords,
            );
            // Unchanged geometry keeps the same rect, so a layout notification re-places nothing.
            setRect((prev) => prev && prev.left === next.left && prev.top === next.top && prev.height === next.height ? prev : next);
        };

        measure();

        // Subscribe to scroll for live tracking (D18).
        el.addEventListener('scroll', measure);
        // A reflow (window resize settling, a pane resizing) moves the textarea without a selection
        // change; its ancestors' resizes say so, as they do for an anchored popover.
        const layoutObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
        for (let node: Element | null = el; node && layoutObserver; node = node.parentElement) {
            layoutObserver.observe(node);
        }

        return () => {
            el.removeEventListener('scroll', measure);
            layoutObserver?.disconnect();
        };
    }, [inputRef, selection?.start, selection?.end, enabled]);

    if (!enabled) return null;

    return rect;
}
