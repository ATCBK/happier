import { describe, expect, it } from 'vitest';
import { readCodeLineIdentifiers, resolveCodeIdentifier } from './codeIdentifiers';

describe('code intelligence identifier positions', () => {
    it('uses the real syntax tokenizer to exclude strings, comments and keywords while retaining UTF-16 offsets', () => {
        const line = 'const 😀 = "hidden"; result = café + value; // ignored';
        expect(readCodeLineIdentifiers(line, 'typescript')).toEqual([
            { symbol: 'result', startCharacter: 21, endCharacter: 27 },
            { symbol: 'café', startCharacter: 30, endCharacter: 34 },
            { symbol: 'value', startCharacter: 37, endCharacter: 42 },
        ]);
    });

    it('resolves a caret after an identifier across CRLF and lone CR without guessing at punctuation', () => {
        expect(resolveCodeIdentifier('first\r\nvalue\rlast', { line: 1, character: 5 }, null)?.symbol).toBe('value');
        expect(resolveCodeIdentifier('first\r\nvalue\rlast', { line: 2, character: 2 }, null)?.symbol).toBe('last');
        expect(resolveCodeIdentifier('value + other', { line: 0, character: 6 }, null)).toBeNull();
        expect(resolveCodeIdentifier('value', { line: -1, character: 0 }, null)).toBeNull();
    });

    it('selects the same Unicode identifiers accepted by the Machine search boundary', () => {
        const line = '℘ + cafe\u0301 + 𝒜 + $item';
        expect(readCodeLineIdentifiers(line, 'typescript').map(name => name.symbol)).toEqual(['℘', 'cafe\u0301', '𝒜', '$item']);
        expect(resolveCodeIdentifier(line, { line: 0, character: line.indexOf('𝒜') + 1 }, 'typescript')?.symbol).toBe('𝒜');
    });
});
