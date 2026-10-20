import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@/dev/testkit';
import { applyHunks, revertHunks } from '@happier-dev/protocol/diff/hunks';
import { buildDiffHunkTable } from '@/components/ui/code/diff/hunks/buildDiffHunkTable';
import { useWorkspaceFileEditorComparison, type EditorComparisonResolution } from './useWorkspaceFileEditorComparison';

const baseText = 'one\nbase A\nmiddle\nbase B\nend\n';
const mineText = 'one\nmine A\nmiddle\nmine B\nend\n';
const theirsText = 'one\ntheirs A\nmiddle\ntheirs B\nend\n';

async function setup(ownerKey = 'file-a') {
    const accepted: EditorComparisonResolution[] = [];
    const hook = await renderHook((key: string) => useWorkspaceFileEditorComparison({ ownerKey: key, onAccept: value => accepted.push(value) }), { initialProps: ownerKey });
    return { ...hook, accepted };
}

describe('workspace editor per-place comparison', () => {
    it('takes one place, keeps the other, then rebases the merged draft to the shown disk hash', async () => {
        const hook = await setup();
        await act(async () => hook.getCurrent().startComparison({ baseText, mineText, theirsText, theirsHash: 'shown-disk' }));
        expect(hook.getCurrent().comparison?.places).toHaveLength(2);
        await act(async () => hook.getCurrent().usePlaceTheirs(0));
        expect(hook.accepted).toEqual([]);
        expect(hook.getCurrent().comparison?.mergedText).toBe('one\ntheirs A\nmiddle\nmine B\nend\n');
        await act(async () => hook.getCurrent().usePlaceMine(1));
        expect(hook.getCurrent().comparison).toBeNull();
        expect(hook.accepted).toEqual([{ text: 'one\ntheirs A\nmiddle\nmine B\nend\n', baseText: theirsText, baseHash: 'shown-disk' }]);
    });

    it('addresses places with the same hunk coordinates as the shared renderer table', async () => {
        const hook = await setup();
        await act(async () => hook.getCurrent().startComparison({ baseText: null, mineText, theirsText, theirsHash: 'disk' }));
        const table = buildDiffHunkTable({ mode: 'text', filePath: 'a.ts', oldText: theirsText, newText: mineText, contextLines: 0 });
        expect(table.hunks.map(hunk => [hunk.hunkIndex, hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines])).toEqual(
            hook.getCurrent().comparison!.places.map(({ hunk }) => [hunk.index, hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]),
        );
        await act(async () => hook.getCurrent().usePlaceTheirs(table.hunks[0]!.hunkIndex));
        await act(async () => hook.getCurrent().usePlaceMine(table.hunks[1]!.hunkIndex));
        expect(hook.accepted[0]?.text).toBe('one\ntheirs A\nmiddle\nmine B\nend\n');
    });

    it('automatically takes disk-only edits in the live session, while a reload asks at every place', async () => {
        const hook = await setup();
        const snapshot = { baseText, mineText: baseText.replace('base A', 'mine A'), theirsText, theirsHash: 'disk' };
        await act(async () => hook.getCurrent().startComparison(snapshot));
        expect(hook.getCurrent().comparison?.places.map(place => [place.choice, place.automatic])).toEqual([[null, false], ['theirs', true]]);
        await act(async () => hook.getCurrent().usePlaceMine(0));
        expect(hook.accepted[0]?.text).toBe('one\nmine A\nmiddle\ntheirs B\nend\n');
        await act(async () => hook.getCurrent().startComparison({ ...snapshot, baseText: null }));
        expect(hook.getCurrent().comparison?.places.map(place => place.choice)).toEqual([null, null]);
    });

    it('composes choices against the original snapshot when taking an earlier insertion shifts later lines', async () => {
        const hook = await setup();
        const mine = 'a\nmine\nb\nc\nmine tail';
        const disk = 'a\ndisk\nextra\nb\nc\ndisk tail\n';
        await act(async () => hook.getCurrent().startComparison({ baseText: null, mineText: mine, theirsText: disk, theirsHash: 'disk' }));
        await act(async () => hook.getCurrent().usePlaceTheirs(0));
        await act(async () => hook.getCurrent().usePlaceTheirs(1));
        expect(hook.accepted[0]?.text).toBe(disk);
    });

    it('can revise a place choice before finishing without accumulating edits and round-trips the shared engine', async () => {
        const hook = await setup();
        await act(async () => hook.getCurrent().startComparison({ baseText: null, mineText, theirsText, theirsHash: 'disk' }));
        const hunks = hook.getCurrent().comparison!.places.map(place => place.hunk);
        expect(applyHunks(theirsText, hunks)).toEqual({ ok: true, text: mineText });
        expect(revertHunks(mineText, hunks)).toEqual({ ok: true, text: theirsText });
        await act(async () => hook.getCurrent().usePlaceTheirs(0));
        await act(async () => hook.getCurrent().usePlaceMine(0));
        expect(hook.getCurrent().comparison?.mergedText).toBe(mineText);
        await act(async () => hook.getCurrent().useAllMine());
        expect(hook.accepted[0]?.text).toBe(mineText);
    });

    it('Use all theirs preserves CRLF and missing-final-newline bytes; Back leaves the draft untouched', async () => {
        const hook = await setup();
        const disk = '\uFEFFhead\r\ndisk';
        await act(async () => hook.getCurrent().startComparison({ baseText: null, mineText: '\uFEFFhead\r\nmine\r\n', theirsText: disk, theirsHash: 'disk' }));
        await act(async () => hook.getCurrent().backToEditing());
        expect(hook.accepted).toEqual([]);
        await act(async () => hook.getCurrent().startComparison({ baseText: null, mineText: '\uFEFFhead\r\nmine\r\n', theirsText: disk, theirsHash: 'disk' }));
        await act(async () => hook.getCurrent().useAllTheirs());
        expect(hook.accepted).toEqual([{ text: disk, baseText: disk, baseHash: 'disk' }]);
    });

    it('drops a pending comparison on file/account owner change', async () => {
        const hook = await setup();
        await act(async () => hook.getCurrent().startComparison({ baseText: null, mineText, theirsText, theirsHash: 'disk' }));
        expect(hook.getCurrent().comparison).not.toBeNull();
        await hook.rerender('file-b');
        expect(hook.getCurrent().comparison).toBeNull();
        await act(async () => hook.getCurrent().useAllTheirs());
        expect(hook.accepted).toEqual([]);
    });

    it('does not auto-take a disk insertion at the boundary where mine deleted a line', async () => {
        const hook = await setup();
        await act(async () => hook.getCurrent().startComparison({
            baseText: 'a\nbase\nz\n', mineText: 'a\nz\n', theirsText: 'a\ndisk\nz\n', theirsHash: 'disk',
        }));
        expect(hook.getCurrent().comparison?.places.map(place => place.choice)).toEqual([null]);
        expect(hook.accepted).toEqual([]);
    });

    it('keeps the shown encoding attached to the accepted disk version', async () => {
        const hook = await setup();
        const theirsEncoding = { hasBom: true, editable: true, eol: 'crlf' as const, mixedEol: false };
        await act(async () => hook.getCurrent().startComparison({
            baseText: null, mineText: 'mine\r\n', theirsText: 'disk\r\n', theirsHash: 'shown', theirsEncoding,
        }));
        await act(async () => hook.getCurrent().useAllMine());
        expect(hook.accepted[0]?.baseEncoding).toEqual(theirsEncoding);
    });
});
