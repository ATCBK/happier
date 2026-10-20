import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

export const PIERRE_FIND_HIGHLIGHT_CSS = `
::highlight(happier-find) { background-color: var(--happier-find-match); }
::highlight(happier-find-current) { background-color: var(--happier-find-current); color: var(--happier-find-current-foreground); }
`;

export function pierreCodeLineSelector(line: CodeLine, attribute: 'data-line' | 'data-column-number' = 'data-line'): string {
    const removal = line.kind === 'remove';
    const lineNumber = removal ? line.oldLine : line.newLine;
    const type = removal ? "[data-line-type='change-deletion']" : line.kind === 'add'
        ? "[data-line-type='change-addition']" : ":is([data-line-type='context'], [data-line-type='context-expanded'])";
    return `:is([data-unified], [data-${removal ? 'deletions' : 'additions'}]) ${type}[${attribute}='${lineNumber}']`;
}

function textRange(element: Element, start: number, end: number): Range | null {
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

/** Each mounted diff owns only its ranges in the document-wide highlight registry. */
export function registerPierreFindHighlights(
    root: ParentNode,
    lines: readonly CodeLine[],
    rangesByLineId: ReadonlyMap<string, readonly FindTextRange[]> | undefined,
): () => void {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined' || !rangesByLineId?.size) return () => {};
    const owned: Array<Readonly<{ name: string; highlight: Highlight; range: Range }>> = [];
    for (const line of lines) {
        const matches = rangesByLineId.get(line.id);
        if (!matches?.length || line.renderIsHeaderLine) continue;
        const content = root.querySelector(pierreCodeLineSelector(line));
        if (!content) continue;
        for (const match of matches) {
            const range = textRange(content, match.start, match.end);
            if (!range) continue;
            const name = match.current ? 'happier-find-current' : 'happier-find';
            const highlight = CSS.highlights.get(name) ?? new Highlight();
            if (match.current) highlight.priority = 1;
            highlight.add(range);
            CSS.highlights.set(name, highlight);
            owned.push({ name, highlight, range });
        }
    }
    return () => {
        for (const { name, highlight, range } of owned) {
            highlight.delete(range);
            if (highlight.size === 0 && CSS.highlights.get(name) === highlight) CSS.highlights.delete(name);
        }
    };
}
