import { describe, expect, it } from 'vitest';

import { applyDocumentTextEdit, applyWorkspaceFileTextEdits, positionToOffset, readDocumentLine, resolveDocumentPosition, resolveSymbolColumn } from './documentText';
import { applyInverseEdits } from '@happier-dev/protocol/diff/hunks';

describe('language server document text', () => {
    it('preserves LSP array order for same-position insertions followed by a replacement', () => {
        const position = { line: 0, character: 0 };
        const edited = applyWorkspaceFileTextEdits('old!', [
            { range: { start: position, end: position }, text: 'first ' },
            { range: { start: position, end: position }, text: 'second ' },
            { range: { start: position, end: { line: 0, character: 3 } }, text: 'new' },
        ]);
        expect(edited.text).toBe('first second new!');
        expect(applyInverseEdits(edited.text, edited.edits)).toEqual({ ok: true, text: 'old!' });
    });
    it('keeps adjacent removals undoable and refuses a range that would corrupt a Unicode scalar', () => {
        const edited = applyWorkspaceFileTextEdits('abcd', [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, text: '' },
            { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } }, text: '' },
        ]);
        expect(edited.text).toBe('');
        expect(applyInverseEdits(edited.text, edited.edits)).toEqual({ ok: true, text: 'abcd' });
        expect(() => applyWorkspaceFileTextEdits('😀', [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, text: '' },
        ])).toThrowError(expect.objectContaining({ code: 'invalid_position' }));
    });
    it('resolves whole Unicode identifiers, exact case before folded case, with occurrences', () => {
        const text = '😀 foobar Foo foo Foo $name café ℘value 𐐀Name';
        expect(resolveSymbolColumn(text, { line: 0, symbol: 'Foo', occurrence: 2 })).toBe(18);
        expect(resolveDocumentPosition(text, { line: 0, symbol: 'Foo', occurrence: 2 })).toEqual({ line: 0, character: 18 });
        expect(resolveSymbolColumn(text, { line: 0, symbol: 'FOO', occurrence: 2 })).toBe(14);
        expect(resolveSymbolColumn(text, { line: 0, symbol: '$name' })).toBe(22);
        expect(resolveSymbolColumn(text, { line: 0, symbol: 'café' })).toBe(28);
        expect(resolveSymbolColumn(text, { line: 0, symbol: '℘value' })).toBe(33);
        expect(resolveSymbolColumn(text, { line: 0, symbol: '𐐀Name' })).toBe(40);
        expect(() => resolveSymbolColumn(text, { line: 0, symbol: 'bar' })).toThrowError(expect.objectContaining({ code: 'symbol_not_found', candidates: ['foobar', 'Foo', 'foo', '$name', 'café', '℘value', '𐐀Name'] }));
        expect(() => resolveDocumentPosition(text, { line: 0 } as { line: number; character: number })).toThrowError(expect.objectContaining({ code: 'invalid_position' }));
        expect(() => resolveSymbolColumn('123foo foo', { line: 0, symbol: 'foo', occurrence: 2 })).toThrowError(expect.objectContaining({ code: 'symbol_not_found' }));
    });

    it.each(['\n', '\r\n', '\r'])('applies UTF-16 range edits with %j line breaks', lineBreak => {
        const text = `😀one${lineBreak}two${lineBreak}`;
        expect(positionToOffset(text, { line: 1, character: 1 })).toBe(5 + lineBreak.length + 1);
        expect(readDocumentLine(text, 2)).toBe('');
        expect(applyDocumentTextEdit(text, { startLine: 0, startCharacter: 2, endLine: 1, endCharacter: 2, text: '!' })).toBe(`😀!o${lineBreak}`);
        expect(resolveDocumentPosition(text, { line: 0, character: 2 })).toEqual({ line: 0, character: 2 });
        expect(() => positionToOffset(text, { line: 0, character: 6 })).toThrowError(expect.objectContaining({ code: 'invalid_position' }));
        expect(() => positionToOffset(text, { line: 3, character: 0 })).toThrowError(expect.objectContaining({ code: 'invalid_position' }));
        expect(() => applyDocumentTextEdit(text, { startLine: 1, startCharacter: 0, endLine: 0, endCharacter: 0, text: '' })).toThrowError(expect.objectContaining({ code: 'invalid_position' }));
    });
});
