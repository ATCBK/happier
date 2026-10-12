import { describe, expect, it } from 'vitest';

import { buildCommitSelectionPathHints, countCommitSelectionItems } from './commitSelectionHints';

describe('commitSelectionHints', () => {
    it('dedupes literal paths from selections and patches, excluding only empty paths', () => {
        const hints = buildCommitSelectionPathHints({
            commitSelectionPaths: ['file', 'file ', '', ' ', 'file '],
            commitSelectionPatches: [
                { path: 'file ', patch: '...' },
                { path: ' file', patch: '...' },
                { path: '', patch: '...' },
            ],
        });

        expect(new Set(hints)).toEqual(new Set(['file', 'file ', ' ', ' file']));
    });

    it('counts unique selection items', () => {
        expect(
            countCommitSelectionItems({
                commitSelectionPaths: ['a.txt', ' a.txt ', ''],
                commitSelectionPatches: [
                    { path: 'b.txt', patch: '...' },
                    { path: 'b.txt', patch: '...' },
                ],
            })
        ).toBe(3);
    });
});
