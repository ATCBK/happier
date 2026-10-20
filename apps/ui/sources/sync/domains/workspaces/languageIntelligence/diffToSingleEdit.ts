import type { LanguageIntelligenceEdit } from '@happier-dev/protocol/machines/languageIntelligence';

function positionAt(text: string, end: number) {
    let line = 0;
    let character = 0;
    for (let index = 0; index < end; index++) {
        if (text[index] === '\r') {
            if (text[index + 1] === '\n' && index + 1 < end) index++;
            line++; character = 0;
        } else if (text[index] === '\n') { line++; character = 0; }
        else character++;
    }
    return { line, character };
}
function splitsUnit(text: string, offset: number): boolean {
    const previous = text.charCodeAt(offset - 1);
    const next = text.charCodeAt(offset);
    return (previous === 13 && next === 10) || (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}
/** One compact replacement, with LSP line breaks and UTF-16 columns. */
export function diffToSingleEdit(previous: string, next: string): LanguageIntelligenceEdit | null {
    if (previous === next) return null;
    let start = 0;
    while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
    if (splitsUnit(previous, start) || splitsUnit(next, start)) start--;
    let oldEnd = previous.length;
    let newEnd = next.length;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
    if (splitsUnit(previous, oldEnd) || splitsUnit(next, newEnd)) { oldEnd++; newEnd++; }
    const from = positionAt(previous, start);
    const to = positionAt(previous, oldEnd);
    return { startLine: from.line, startCharacter: from.character, endLine: to.line, endCharacter: to.character,
        text: next.slice(start, newEnd) };
}
