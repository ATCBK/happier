import { describe, expect, it } from 'vitest';
import { diffToSingleEdit } from './diffToSingleEdit';

function offsetAt(text: string, line: number, character: number): number {
    const breaks = [...text.matchAll(/\r\n|\r|\n/gu)];
    return (line === 0 ? 0 : breaks[line - 1].index + breaks[line - 1][0].length) + character;
}
describe('compact editor document synchronization', () => {
    it('round trips edits across LSP line endings, astral names and combining marks', () => {
        const samples = ['', 'a', '\r\n', '\n', '\r', '😀', '𝒜', 'café', 'a\r\nb\rc\nd', '😀\r\n𝒜'];
        for (const previous of samples) for (const next of samples) {
            const edit = diffToSingleEdit(previous, next);
            if (!edit) { expect(previous).toBe(next); continue; }
            const start = offsetAt(previous, edit.startLine, edit.startCharacter);
            const end = offsetAt(previous, edit.endLine, edit.endCharacter);
            expect(previous.slice(0, start) + edit.text + previous.slice(end)).toBe(next);
        }
    });
    it('sends only the changed span of a 5,000-line file, not a full-file replacement', () => {
        const before = Array.from({ length: 5000 }, (_, index) => `const value${index} = 1;`).join('\r\n');
        const after = before.replace('value2500 = 1', 'value2500 = 2');
        expect(diffToSingleEdit(before, after)).toEqual({ startLine: 2500, startCharacter: 18,
            endLine: 2500, endCharacter: 19, text: '2' });
    });
});
