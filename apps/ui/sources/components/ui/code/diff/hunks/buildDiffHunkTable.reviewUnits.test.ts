import { describe, expect, it } from 'vitest';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { buildDiffHunkTable } from './buildDiffHunkTable';

describe('captured review identity at the diff table seam', () => {
    it('keeps the producer’s layer-specific keys and the renderer’s line destinations together', () => {
        const unifiedDiff = '@@ -1 +1 @@\n-old\n+new\n';
        const reviewUnits = buildReviewUnits('a.ts', 'staged', unifiedDiff);
        const table = buildDiffHunkTable({ mode: 'unified', filePath: 'a.ts', unifiedDiff, reviewUnits });
        expect(table.hunks.map(hunk => hunk.key)).toEqual(reviewUnits.map(unit => unit.key));
        expect(table.hunks[0]?.firstChangeLineId).toBe('r:1');
    });
});
