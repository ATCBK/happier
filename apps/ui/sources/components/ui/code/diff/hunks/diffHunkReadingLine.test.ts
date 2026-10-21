import { describe, expect, it } from 'vitest';
import { pickReadingLineHunk } from './diffHunkReadingLine';

const keys = ['c1', 'c2', 'c3', 'c4'];
const keyAt = (index: number) => keys[index];

describe('the change crossing the reading line', () => {
    it('is the last change whose row has passed the line, whichever rows are mounted', () => {
        const rows = [{ key: 'c1', index: 0, top: -400 }, { key: 'c2', index: 1, top: 120 }, { key: 'c3', index: 2, top: 600 }];
        expect(pickReadingLineHunk(rows, 280, keyAt)).toBe('c2');
        // Before the first change's row reaches the line, the first change is still the one ahead.
        expect(pickReadingLineHunk(rows.map(row => ({ ...row, top: row.top + 1000 })), 280, keyAt)).toBe('c1');
        // A long change whose row scrolled out of the list (virtualized) is named by the row below the line.
        expect(pickReadingLineHunk([{ key: 'c4', index: 3, top: 500 }], 280, keyAt)).toBe('c3');
        expect(pickReadingLineHunk([], 280, keyAt)).toBeNull();
    });
});
