import { describe, expect, it } from 'vitest';

import { buildCodeLinesFromTextDiff } from './buildCodeLinesFromTextDiff';

describe('buildCodeLinesFromTextDiff', () => {
    it('uses the canonical hunk boundaries when change contexts do not touch', () => {
        const oldText = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join('');
        const newText = oldText.replace('line 3\n', 'changed 3\n').replace('line 11\n', 'changed 11\n');
        const lines = buildCodeLinesFromTextDiff({ oldText, newText, contextLines: 3 });
        expect(lines.filter(line => line.kind === 'header').map(line => [line.id, line.hunkIndex])).toEqual([
            ['th:0', 0], ['th:1', 1],
        ]);
        expect(lines.filter(line => line.kind === 'add').map(line => [line.newLine, line.hunkIndex])).toEqual([[3, 0], [11, 1]]);
    });
    it('produces add/remove/context code lines from old/new text', () => {
        const oldText = 'a\nkeep\n';
        const newText = 'b\nkeep\n';

        const lines = buildCodeLinesFromTextDiff({ oldText, newText, contextLines: 1 });
        const body = lines.filter((l) => !l.renderIsHeaderLine);

        expect(body.some((l) => l.kind === 'remove' && l.renderCodeText.includes('a'))).toBe(true);
        expect(body.some((l) => l.kind === 'add' && l.renderCodeText.includes('b'))).toBe(true);
        expect(body.some((l) => l.kind === 'context' && l.renderCodeText.includes('keep'))).toBe(true);
    });
});
