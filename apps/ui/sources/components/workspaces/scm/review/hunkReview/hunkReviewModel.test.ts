import { describe, expect, it } from 'vitest';
import { buildHunkReviewSummary, moveHunkReviewCursor, orderHunkReviewFiles, resolveHunkReviewUnit, type HunkReviewFile } from './hunkReviewModel';

const files: readonly HunkReviewFile[] = [
    { path: 'a.ts', keys: ['a1', 'a2'] },
    { path: 'b.ts', keys: ['b1'] },
    { path: 'yarn.lock', keys: ['l1'], lockfile: true },
    { path: 'c.ts', keys: ['c1'] },
];

describe('review cursor and counter', () => {
    it('classifies live paths with no captured metadata through the canonical path classifier', () => {
        expect(orderHunkReviewFiles([{ path: 'a.ts', keys: ['a'] }, { path: 'yarn.lock', keys: ['lock'] },
            { path: 'z.ts', keys: ['z'] }]).map(file => file.path)).toEqual(['a.ts', 'z.ts', 'yarn.lock']);
    });
    it('re-resolves a stable key after unrelated movement, but refuses changed content and another source scope', () => {
        const unit = { key: 'same-content' };
        expect(resolveHunkReviewUnit({ renderedScopeId: 'scope', currentScopeId: 'scope', key: unit.key,
            units: [{ key: 'inserted' }, unit] })).toBe(unit);
        expect(resolveHunkReviewUnit({ renderedScopeId: 'scope', currentScopeId: 'scope', key: unit.key, units: [] })).toBeNull();
        expect(resolveHunkReviewUnit({ renderedScopeId: 'scope', currentScopeId: 'other', key: unit.key, units: [unit] })).toBeNull();
    });
    it('moves by change, skips kept files across the boundary, and leaves generated files until last', () => {
        const marked = new Set(['b1']);
        expect(moveHunkReviewCursor(files, null, 1, marked)).toEqual({ path: 'a.ts', key: 'a1' });
        expect(moveHunkReviewCursor(files, { path: 'a.ts', key: 'a1' }, 1, marked)).toEqual({ path: 'a.ts', key: 'a2' });
        expect(moveHunkReviewCursor(files, { path: 'a.ts', key: 'a2' }, 1, marked)).toEqual({ path: 'c.ts', key: 'c1' });
        expect(moveHunkReviewCursor(files, { path: 'c.ts', key: 'c1' }, 1, marked)).toEqual({ path: 'yarn.lock', key: 'l1' });
        expect(moveHunkReviewCursor(files, { path: 'a.ts', key: 'a1' }, 1, marked, true)).toEqual({ path: 'c.ts', key: 'c1' });
    });

    it('counts content keys across files and marks a file reviewed only when every run is kept', () => {
        const summary = buildHunkReviewSummary(files, new Set(['a1', 'b1', 'not-in-this-capture']));
        expect(summary).toMatchObject({ reviewed: 2, total: 5, files: 4, remaining: 3 });
        expect([...summary.reviewedPaths]).toEqual(['b.ts']);
        expect(buildHunkReviewSummary([], new Set()).total).toBe(0);
        expect(moveHunkReviewCursor([], null, 1, new Set())).toBeNull();
    });

    it('can enter a pending diff without inventing a change identity', () => {
        expect(moveHunkReviewCursor([{ path: 'a.ts', keys: ['a1'] }, { path: 'b.ts', keys: [], pending: true }],
            { path: 'a.ts', key: 'a1' }, 1, new Set())).toEqual({ path: 'b.ts', key: null });
    });

    it('resolves a moved key by identity and wraps only after there are no unreviewed destinations', () => {
        const marked = new Set(['a1', 'a2', 'b1', 'l1', 'c1']);
        expect(moveHunkReviewCursor(files, { path: 'a.ts', key: 'a2' }, 1, marked)).toEqual({ path: 'b.ts', key: 'b1' });
        expect(moveHunkReviewCursor([{ path: 'a.ts', keys: ['before', 'a1', 'a2'] }], { path: 'a.ts', key: 'a1' }, 1, new Set()))
            .toEqual({ path: 'a.ts', key: 'a2' });
    });
});
