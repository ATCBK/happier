import { describe, expect, it } from 'vitest';

import { excerptAroundFirstMatch } from './conversationPreviewExcerpt';

const filler = (words: number) => Array.from({ length: words }, (_, index) => `word${index}`).join(' ');

describe('excerptAroundFirstMatch', () => {
    it('leaves a block that fits as it is', () => {
        expect(excerptAroundFirstMatch('A short harbor note', 'harbor')).toBe('A short harbor note');
    });

    it('windows a long block on its first hit, keeping the hit and marking both cut edges', () => {
        const text = `${filler(400)} the harbor lantern ${filler(400)}`;
        const excerpt = excerptAroundFirstMatch(text, 'harbor', 300);
        expect(excerpt).toContain('harbor lantern');
        expect(excerpt.startsWith('…')).toBe(true);
        expect(excerpt.endsWith('…')).toBe(true);
        expect(excerpt.length).toBeLessThanOrEqual(300 + 2);
        // Cut at a word edge: the window opens on a whole word.
        expect(excerpt).toMatch(/^…word\d+ /);
        expect(text).toContain(excerpt.slice(1, -1).trim());
    });

    it('opens a long block without a hit at its start', () => {
        const excerpt = excerptAroundFirstMatch(filler(400), 'harbor', 300);
        expect(excerpt.startsWith('word0 ')).toBe(true);
        expect(excerpt.endsWith('…')).toBe(true);
    });

    it('does not cut at the start when the hit is already near it', () => {
        const text = `The harbor lantern is first. ${filler(400)}`;
        expect(excerptAroundFirstMatch(text, 'harbor', 300).startsWith('The harbor lantern')).toBe(true);
    });
});
