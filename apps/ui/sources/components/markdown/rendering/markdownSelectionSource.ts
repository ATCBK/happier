import { projectMarkdownFindText } from './markdownFindProjection';

const isSpace = (char: string) => /\s/.test(char);

/**
 * Where a selection the reader made in rendered Markdown sits in the Markdown source.
 *
 * `rendered` is the text the renderer drew (for example a web container's `textContent`) and
 * `start`/`end` index the selection in it. The rendered text is walked in order against the
 * grammar-owned display projection that Find uses, so a repeated phrase resolves to the occurrence
 * the reader selected; the quote is never searched for. Block breaks and whitespace may differ,
 * and glyphs the renderer adds (list bullets, list numbers) are stepped over. Returns `null`
 * unless every selected visible character lands on a source character.
 */
export function mapRenderedSelectionToMarkdownSource(input: Readonly<{
    markdown: string;
    rendered: string;
    start: number;
    end: number;
}>): Readonly<{ start: number; end: number }> | null {
    const { rendered } = input;
    if (input.start < 0 || input.end > rendered.length || input.start >= input.end) return null;
    const display = projectMarkdownFindText(input.markdown);
    let cursor = 0;
    let first: number | null = null;
    let last: number | null = null;
    for (let index = 0; index < input.end; index++) {
        const char = rendered[index]!;
        if (isSpace(char)) continue;
        while (cursor < display.text.length && isSpace(display.text[cursor]!)) cursor++;
        const matched = cursor < display.text.length && display.text[cursor] === char;
        if (index >= input.start) {
            if (!matched) return null;
            first ??= cursor;
            last = cursor;
        }
        if (matched) cursor++;
    }
    if (first === null || last === null) return null;
    return { start: display.sourceOffsets[first]!, end: display.sourceEnds[last]! };
}
