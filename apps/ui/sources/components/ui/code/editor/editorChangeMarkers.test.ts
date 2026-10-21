import { describe, expect, it } from 'vitest';
import { buildEditorChangeMarkers, rederiveEditorChangeMarkers, revertEditorChangeInDraft } from './editorChangeMarkers';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';

const diff = '@@ -1,5 +1,5 @@\n first\n-old\n+new\n middle\n-gone\n last\n+added\n';

describe('editor change markers from canonical review units', () => {
    it.each([
        { patch: '@@ -1 +1,2 @@\n-old\n+new\n+extra\n', seed: 'new\nextra\ntail\n', reverted: 'old\ntail\n' },
        { patch: '@@ -0,0 +1 @@\n+added\n', seed: 'added\ntail\n', reverted: 'tail\n' },
        { patch: '@@ -1 +0,0 @@\n-deleted\n', seed: 'tail\n', reverted: 'deleted\ntail\n' },
        { patch: '@@ -1 +1 @@\n-old\r\n+new\r\n', seed: 'new\r\ntail\r\n', reverted: 'old\r\ntail\r\n' },
        { patch: '@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n', seed: 'new', reverted: 'old' },
    ])('re-derives scope identity and ranges across restored/reverted buffers: $patch', ({ patch, seed, reverted }) => {
        const markers = buildEditorChangeMarkers('file.ts', 'staged', patch);
        expect(rederiveEditorChangeMarkers(seed, reverted, markers)).toEqual([]);
        const prefix = 'unrelated\n';
        if (markers[0]!.hunk.oldLines > 0 && markers[0]!.hunk.newLines > 0) {
            expect(rederiveEditorChangeMarkers(seed, `${prefix}${reverted}`, markers)).toEqual([]);
        }
        const shifted = markers[0]!.hunk.oldLines > 0 && markers[0]!.hunk.newLines > 0 ? prefix : '';
        const restored = rederiveEditorChangeMarkers(seed, `${shifted}${seed}`, markers)!;
        expect(restored).toHaveLength(1);
        expect(restored[0]!.key).toBe(markers[0]!.key);
        expect(revertEditorChangeInDraft(`${shifted}${seed}`, restored[0]!)).toEqual({ ok: true, text: `${shifted}${reverted}` });
        expect(rederiveEditorChangeMarkers(seed, seed, markers)).toMatchObject(markers);
    });
    it('keeps repeated-text changes associated with their original scope keys', () => {
        const markers = buildEditorChangeMarkers('file.ts', null, '@@ -2 +2 @@\n-old A\n+new\n@@ -4 +4 @@\n-old B\n+new\n');
        const seed = 'repeat\nnew\nrepeat\nnew\ntail\n';
        expect(rederiveEditorChangeMarkers(seed, 'repeat\nnew\nrepeat\nold B\ntail\n', markers))
            .toMatchObject([{ key: markers[0]!.key, startLine: 2, endLine: 2 }]);
        expect(rederiveEditorChangeMarkers(seed, seed, markers)).toMatchObject(markers);
    });
    it('retains the selected review owner layer keys rather than rebuilding combined keys', () => {
        const units = buildReviewUnits('file.ts', 'staged', diff);
        const markers = buildEditorChangeMarkers('file.ts', null, diff, units);
        expect(markers.map(marker => marker.key)).toEqual(units.map(unit => unit.key));
    });
    it('projects individual runs with their removed lines and content keys', () => {
        const markers = buildEditorChangeMarkers('file.ts', null, diff);
        expect(markers.map((marker) => ({ kind: marker.kind, start: marker.startLine, end: marker.endLine, removed: marker.removedLines }))).toEqual([
            { kind: 'modified', start: 2, end: 2, removed: ['old'] },
            { kind: 'deleted', start: 3, end: 3, removed: ['gone'] },
            { kind: 'added', start: 5, end: 5, removed: [] },
        ]);
        expect(new Set(markers.map((marker) => marker.key)).size).toBe(3);
    });

    it('reverts at the tracked range without touching disk and refuses an edited region', () => {
        const marker = buildEditorChangeMarkers('file.ts', null, diff)[0]!;
        const moved = { ...marker, startLine: 3, endLine: 3 };
        expect(revertEditorChangeInDraft('before\nfirst\nnew\nmiddle\nlast\nadded\n', moved)).toEqual({ ok: true, text: 'before\nfirst\nold\nmiddle\nlast\nadded\n' });
        expect(revertEditorChangeInDraft('before\nfirst\nyours\nmiddle\nlast\nadded\n', moved)).toEqual({ ok: false, reason: 'moved_on' });
        expect(revertEditorChangeInDraft('before\nfirst\nnew\ninside\nmiddle\nlast\nadded\n', { ...moved, endLine: 4 })).toEqual({ ok: false, reason: 'moved_on' });
    });

    it('restores deletions at the start of a file and preserves the last-line terminator', () => {
        const marker = buildEditorChangeMarkers('file.ts', null, '@@ -1,2 +1 @@\n-removed\n kept\n')[0]!;
        expect(revertEditorChangeInDraft('kept\n', marker)).toEqual({ ok: true, text: 'removed\nkept\n' });
        const edited = rederiveEditorChangeMarkers('kept\n', 'my edit\nkept\n', [marker])!;
        expect(revertEditorChangeInDraft('my edit\nkept\n', edited[0]!)).toEqual({ ok: false, reason: 'moved_on' });
    });
    it('adapts first-line BOM bytes to the editor text representation without changing the review key', () => {
        const diff = '@@ -1 +1 @@\n-\uFEFFold\n+\uFEFFnew\n';
        const marker = buildEditorChangeMarkers('file.ts', null, diff)[0]!;
        expect(marker.key).toBe(buildReviewUnits('file.ts', null, diff)[0]!.key);
        expect(revertEditorChangeInDraft('new\n', marker)).toEqual({ ok: true, text: 'old\n' });
    });
    it('keeps an encoding-only marker but reports draft reversal unavailable, and retains embedded BOM characters', () => {
        const markers = buildEditorChangeMarkers('file.ts', null, '@@ -1 +1 @@\n-old\n+\uFEFFold\n');
        expect(markers).toHaveLength(1);
        expect(revertEditorChangeInDraft('old\n', markers[0]!)).toEqual({ ok: false, reason: 'unavailable' });
        const embedded = buildEditorChangeMarkers('file.ts', null, '@@ -2 +2 @@\n-\uFEFFold\n+\uFEFFnew\n')[0]!;
        expect(revertEditorChangeInDraft('first\n\uFEFFnew\n', embedded)).toEqual({ ok: true, text: 'first\n\uFEFFold\n' });
    });
});
