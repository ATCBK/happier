import { queryRanges } from '@/components/ui/text/queryRanges';

/**
 * About what the preview column shows without scrolling: ~42 characters a line at its text size, ~17 lines.
 * A matched message longer than this is read through a window on its first hit, so the hit is on screen when
 * the preview opens instead of far below it; Open in Happier lands on the whole message.
 */
const PREVIEW_EXCERPT_CHARS = 700;
/** The hit sits in the window's first third, so it reads with the sentence that leads into it. */
const PREVIEW_EXCERPT_LEAD_SHARE = 1 / 3;

/** The window of a long block that holds its first match, cut at word edges and marked with ellipses. */
export function excerptAroundFirstMatch(text: string, query: string, maxChars = PREVIEW_EXCERPT_CHARS): string {
    if (text.length <= maxChars) return text;
    const first = queryRanges(text, query)?.[0];
    const wanted = first ? Math.max(0, first.start - Math.floor(maxChars * PREVIEW_EXCERPT_LEAD_SHARE)) : 0;
    const start = wanted === 0 ? 0 : snapToWordEdge(text, wanted, 'forward');
    const end = start + maxChars >= text.length ? text.length : snapToWordEdge(text, start + maxChars, 'backward');
    return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

function snapToWordEdge(text: string, index: number, direction: 'forward' | 'backward'): number {
    const step = direction === 'forward' ? 1 : -1;
    for (let at = index; at > 0 && at < text.length; at += step) {
        if (/\s/.test(text[at]!)) return at;
        if (Math.abs(at - index) > 40) break;
    }
    return index;
}
