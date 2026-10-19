import { projectMarkdownFindText } from './markdownFindProjection';

const isSpace = (char: string) => /\s/.test(char);

type RenderedAlignment = Readonly<{
    display: ReturnType<typeof projectMarkdownFindText>;
    /** For each rendered character, the display character it draws, or -1 (whitespace, renderer glyphs). */
    displayIndex: readonly number[];
}>;

/**
 * Walk the rendered text in order against the grammar-owned display projection that Find uses.
 * Block breaks and whitespace may differ, and glyphs the renderer adds (list bullets, list numbers)
 * are stepped over; nothing is ever searched for, so repeated phrases keep their own positions.
 */
function alignRenderedToMarkdown(markdown: string, rendered: string, through = rendered.length): RenderedAlignment {
    const display = projectMarkdownFindText(markdown);
    const displayIndex: number[] = [];
    let cursor = 0;
    for (let index = 0; index < through; index++) {
        const char = rendered[index]!;
        if (isSpace(char)) { displayIndex.push(-1); continue; }
        while (cursor < display.text.length && isSpace(display.text[cursor]!)) cursor++;
        const matched = cursor < display.text.length && display.text[cursor] === char;
        displayIndex.push(matched ? cursor : -1);
        if (matched) cursor++;
    }
    return { display, displayIndex };
}

/**
 * Where a selection the reader made in rendered Markdown sits in the Markdown source.
 *
 * `rendered` is the text the renderer drew (for example a web container's `textContent`) and
 * `start`/`end` index the selection in it. A repeated phrase resolves to the occurrence the reader
 * selected. Returns `null` unless every selected visible character lands on a source character.
 */
export function mapRenderedSelectionToMarkdownSource(input: Readonly<{
    markdown: string;
    rendered: string;
    start: number;
    end: number;
}>): Readonly<{ start: number; end: number }> | null {
    const { rendered } = input;
    if (input.start < 0 || input.end > rendered.length || input.start >= input.end) return null;
    const { display, displayIndex } = alignRenderedToMarkdown(input.markdown, rendered, input.end);
    let first: number | null = null;
    let last: number | null = null;
    for (let index = input.start; index < input.end; index++) {
        if (isSpace(rendered[index]!)) continue;
        const at = displayIndex[index]!;
        if (at < 0) return null;
        first ??= at;
        last = at;
    }
    if (first === null || last === null) return null;
    return { start: display.sourceOffsets[first]!, end: display.sourceEnds[last]! };
}

/**
 * The inverse: where a stored source passage (a Doc passage's canonical Markdown offsets) is drawn
 * in the rendered text, so the reader sees the exact passage that was commented on. Returns `null`
 * when no drawn character belongs to the range.
 */
export function mapMarkdownSourceToRenderedRange(input: Readonly<{
    markdown: string;
    rendered: string;
    start: number;
    end: number;
}>): Readonly<{ start: number; end: number }> | null {
    if (input.start >= input.end) return null;
    const { display, displayIndex } = alignRenderedToMarkdown(input.markdown, input.rendered);
    let first: number | null = null;
    let last: number | null = null;
    for (let index = 0; index < displayIndex.length; index++) {
        const at = displayIndex[index]!;
        if (at < 0) continue;
        if (display.sourceOffsets[at]! >= input.start && display.sourceEnds[at]! <= input.end) {
            first ??= index;
            last = index;
        }
    }
    return first === null || last === null ? null : { start: first, end: last + 1 };
}

/**
 * The passage a rendered block stands for, in the Markdown source: from its first to its last drawn
 * character, so the block's own marks (`# `, `- **`) stay out. Native renderers report a selection in
 * their own drawn text, which cannot be placed in the source without searching; there the block the
 * reader chose is the passage. Returns `null` when the block draws nothing from the source.
 */
export function mapMarkdownSourceBlockToPassage(input: Readonly<{
    markdown: string;
    start: number;
    end: number;
}>): Readonly<{ start: number; end: number }> | null {
    const display = projectMarkdownFindText(input.markdown);
    let first: number | null = null;
    let last: number | null = null;
    for (let index = 0; index < display.text.length; index++) {
        if (isSpace(display.text[index]!)) continue;
        if (display.sourceOffsets[index]! < input.start || display.sourceEnds[index]! > input.end) continue;
        first ??= index;
        last = index;
    }
    return first === null || last === null ? null : { start: display.sourceOffsets[first]!, end: display.sourceEnds[last]! };
}
