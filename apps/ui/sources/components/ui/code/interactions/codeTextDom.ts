import type { Rect } from '../editor/codeEditorTypes';

/** Browser hit testing over code text, shared by the read view and shadow-root diff bodies. */
export function readCodeTextPointer(code: Element, x: number, y: number): Readonly<{ offset16: number; rect: Rect }> | null {
    const document = code.ownerDocument;
    const root = code.getRootNode();
    const shadowRoot = root.nodeType === 11 && 'host' in root ? root as ShadowRoot : null;
    const caretDocument = document as Document & {
        caretPositionFromPoint?: (x: number, y: number, options?: { shadowRoots: ShadowRoot[] }) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = shadowRoot
        ? caretDocument.caretPositionFromPoint?.(x, y, { shadowRoots: [shadowRoot] })
        : caretDocument.caretPositionFromPoint?.(x, y);
    const caretRoot = shadowRoot as (ShadowRoot & { caretRangeFromPoint?: (x: number, y: number) => Range | null }) | null;
    const caretRange = position ? null : caretRoot?.caretRangeFromPoint?.(x, y) ?? caretDocument.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode ?? caretRange?.startContainer;
    const offset = position?.offset ?? caretRange?.startOffset;
    if (!node || offset === undefined || !code.contains(node)) return null;
    const range = document.createRange();
    range.selectNodeContents(code);
    range.setEnd(node, offset);
    const box = code.getBoundingClientRect();
    return { offset16: range.toString().length, rect: { x, y: box.top, width: 1, height: box.height } };
}

/** A UTF-16 span across syntax-token text nodes, without altering renderer-owned markup. */
export function codeTextRange(element: Element, start: number, end: number): Range | null {
    if (end <= start) return null;
    const walker = element.ownerDocument.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = element.ownerDocument.createRange();
    let offset = 0;
    let started = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0;
        if (!started && start < offset + length) {
            range.setStart(node, Math.max(0, start - offset));
            started = true;
        }
        if (started && end <= offset + length) {
            range.setEnd(node, Math.max(0, end - offset));
            return range;
        }
        offset += length;
    }
    return null;
}
