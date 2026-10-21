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

    it('reveals a change from the line its row sits under, so a top-aligned landing shows the "Change n" row', () => {
        const unifiedDiff = '@@ -1,5 +1,5 @@\n-one\n+ONE\n a\n b\n-two\n+TWO\n c\n';
        const table = buildDiffHunkTable({ mode: 'unified', filePath: 'a.ts', unifiedDiff });
        const [first, second] = table.hunks;
        // A change at the hunk's start has only the hunk header above it: its own first line is the target.
        expect(first?.revealLineId).toBe(first?.firstChangeLineId);
        // Otherwise the target is the context line the row is drawn after (one line of context, then the row).
        const anchored = [...table.hunksByAfterLineId.entries()].find(([, hunks]) => hunks.includes(second!))?.[0];
        expect(second?.revealLineId).toBe(anchored);
        expect(second?.revealLineId).not.toBe(second?.firstChangeLineId);
    });
});
