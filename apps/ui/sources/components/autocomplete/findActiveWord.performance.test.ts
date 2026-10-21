import { describe, expect, it } from 'vitest';
import { findActiveWord } from './findActiveWord';

describe('active word reference boundary work', () => {
    it('visits each reference once rather than once per scanned character', () => {
        let reads = 0;
        const references = Array.from({ length: 11 }, (_, index) => ({
            get start() { reads++; return index * 10; },
            get end() { reads++; return index * 10 + 8; },
        }));
        const text = 'x'.repeat(110) + ' ' + 'Explain the behavior of this code '.repeat(20) + '@session';
        // The nearest @ is a valid query; plain text must also stay linear while closed.
        expect(findActiveWord(text, { start: text.length, end: text.length }, ['session'], references)?.activeWord).toBe('@session');
        reads = 0;
        const plain = text.slice(0, -8);
        expect(findActiveWord(plain, { start: plain.length, end: plain.length }, ['session'], references)).toBeUndefined();
        expect(reads).toBeLessThanOrEqual(references.length * 2);
    });
});
