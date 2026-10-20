import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { codeTextRange } from '@/components/ui/code/interactions/codeTextDom';

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

/** Each mounted diff owns only its ranges in the document-wide Find/diagnostic highlight registry. */
export function registerPierreTextHighlights(
    ranges: Iterable<Readonly<{ content: Element; start: number; end: number; name: string; priority?: number }>>,
): () => void {
    if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return () => {};
    const owned: Array<Readonly<{ name: string; highlight: Highlight; range: Range }>> = [];
    for (const item of ranges) {
        const range = codeTextRange(item.content, item.start, item.end);
        if (!range) continue;
        const highlight = CSS.highlights.get(item.name) ?? new Highlight();
        if (item.priority !== undefined) highlight.priority = item.priority;
        highlight.add(range);
        CSS.highlights.set(item.name, highlight);
        owned.push({ name: item.name, highlight, range });
    }
    return () => {
        for (const { name, highlight, range } of owned) {
            highlight.delete(range);
            if (highlight.size === 0 && CSS.highlights.get(name) === highlight) CSS.highlights.delete(name);
        }
    };
}

export function registerPierreFindHighlights(
    root: ParentNode,
    lines: readonly CodeLine[],
    rangesByLineId: ReadonlyMap<string, readonly FindTextRange[]> | undefined,
): () => void {
    if (!rangesByLineId?.size) return () => {};
    const ranges: Array<Readonly<{ content: Element; start: number; end: number; name: string; priority?: number }>> = [];
    for (const line of lines) {
        const matches = rangesByLineId.get(line.id);
        if (!matches?.length || line.renderIsHeaderLine) continue;
        const content = root.querySelector(pierreCodeLineSelector(line));
        if (!content) continue;
        for (const match of matches) {
            ranges.push({ content, ...match, name: match.current ? 'happier-find-current' : 'happier-find', ...(match.current ? { priority: 1 } : {}) });
        }
    }
    return registerPierreTextHighlights(ranges);
}
