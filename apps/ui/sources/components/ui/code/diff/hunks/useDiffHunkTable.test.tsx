import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@/dev/testkit';
import { useDiffHunkTable } from './useDiffHunkTable';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { buildDiffHunkTable } from './buildDiffHunkTable';

const PATCH = '@@ -1,5 +1,5 @@ heading\n context\n-old\n+new\n between\n-other\n+changed\n end\n';

describe('the diff review table', () => {
    it('preserves canonical captured layer keys and rejects units from a different displayed patch', () => {
        const reviewUnits = buildReviewUnits('a.ts', 'staged', PATCH);
        const props = { mode: 'unified', filePath: 'a.ts', unifiedDiff: PATCH, reviewUnits } as const;
        expect(buildDiffHunkTable(props).hunks.map((hunk) => hunk.key)).toEqual(reviewUnits.map((unit) => unit.key));
        expect(() => buildDiffHunkTable({ ...props, unifiedDiff: PATCH.replace('+new', '+newer') }))
            .toThrow('Review units do not match displayed diff');
    });
    it('anchors separate change runs to their first changed line and the preceding context', async () => {
        const hook = await renderHook(() => useDiffHunkTable({ mode: 'unified', filePath: 'a.ts', unifiedDiff: PATCH }));
        const table = hook.getCurrent();
        expect(table.hunks.map((hunk) => ({ index: hunk.index, hunkIndex: hunk.hunkIndex, first: hunk.firstChangeLineId })))
            .toEqual([{ index: 0, hunkIndex: 0, first: 'r:2' }, { index: 1, hunkIndex: 0, first: 'r:5' }]);
        expect([...table.hunksByAfterLineId].map(([id, hunks]) => [id, hunks.map((hunk) => hunk.index)]))
            .toEqual([['c:1', [0]], ['c:4', [1]]]);
        expect(table.hunks[0]!.key).not.toBe(table.hunks[1]!.key);
    });

    it('publishes the same table through changing callbacks and review state, rebuilding for evidence changes', async () => {
        const initial = vi.fn();
        const replacement = vi.fn();
        const hook = await renderHook((props: { diff: string; onHunks: typeof initial; currentIndex: number }) =>
            useDiffHunkTable({ mode: 'unified', filePath: 'a.ts', unifiedDiff: props.diff,
                hunks: { onHunks: props.onHunks, currentIndex: props.currentIndex } }),
        { initialProps: { diff: PATCH, onHunks: initial, currentIndex: 0 } });
        const first = hook.getCurrent().hunks;
        expect(initial).toHaveBeenLastCalledWith(first);
        await hook.rerender({ diff: PATCH, onHunks: replacement, currentIndex: 1 });
        expect(hook.getCurrent().hunks).toBe(first);
        expect(replacement).toHaveBeenLastCalledWith(first);
        await hook.rerender({ diff: PATCH.replace('+new', '+newer'), onHunks: replacement, currentIndex: 1 });
        expect(hook.getCurrent().hunks).not.toBe(first);
        expect(hook.getCurrent().hunks[0]!.key).not.toBe(first[0]!.key);
    });

    it('uses the header anchor for a change without leading context and shares text/unified content keys', async () => {
        const unified = await renderHook(() => useDiffHunkTable({ mode: 'unified', filePath: 'a.ts', unifiedDiff: '@@ -1 +1 @@\n-old\n+new\n' }));
        const text = await renderHook(() => useDiffHunkTable({ mode: 'text', filePath: 'a.ts', oldText: 'old\n', newText: 'new\n' }));
        expect([...unified.getCurrent().hunksByAfterLineId.keys()]).toEqual(['h:0']);
        expect(unified.getCurrent().hunks[0]!.key).toBe(text.getCurrent().hunks[0]!.key);
        expect(text.getCurrent().hunks[0]!.firstChangeLineId).toBe('tr:0:0');
    });
});
