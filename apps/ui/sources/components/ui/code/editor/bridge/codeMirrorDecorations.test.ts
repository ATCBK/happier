import { describe, expect, it } from 'vitest';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import { createCodeMirrorDecorations } from './codeMirrorDecorations';

describe('CodeMirror tracked decoration ranges', () => {
    it('maps before, inside and after edits while retaining independently replaceable layers', () => {
        const runtime = createCodeMirrorDecorations({ ...state, ...view });
        let doc = state.EditorState.create({ doc: 'first\nsecond\nthird\nlast', extensions: runtime.extensions });
        doc = doc.update({ effects: runtime.set.of({ layer: 'change', items: [{ id: 'change', key: 'key', kind: 'modified', startLine: 2, endLine: 3 }] }) }).state;
        doc = doc.update({ effects: runtime.set.of({ layer: 'blame', items: [{ id: 'blame', startLine: 1, lineCount: 1, runId: 'run' }] }) }).state;
        doc = doc.update({ changes: { from: 0, insert: 'before\n' } }).state;
        expect(runtime.items(doc, 'change')).toEqual([{ id: 'change', key: 'key', kind: 'modified', startLine: 3, endLine: 4 }]);
        doc = doc.update({ changes: { from: doc.doc.line(4).from, insert: 'inside\n' } }).state;
        expect(runtime.items(doc, 'change')[0]).toMatchObject({ startLine: 3, endLine: 5 });
        doc = doc.update({ changes: { from: doc.doc.length, insert: '\nafter' } }).state;
        expect(runtime.items(doc, 'change')[0]).toMatchObject({ startLine: 3, endLine: 5 });
        doc = doc.update({ changes: { from: 0, to: doc.doc.line(2).from } }).state;
        expect(runtime.items(doc, 'change')[0]).toMatchObject({ startLine: 2, endLine: 4 });
        doc = doc.update({ effects: runtime.set.of({ layer: 'change', items: [] }) }).state;
        expect(runtime.items(doc, 'change')).toEqual([]);
        expect(runtime.items(doc, 'blame')).toHaveLength(1);
    });

    it('retains a collapsed edited change, and projects diagnostic UTF-16 positions', () => {
        const runtime = createCodeMirrorDecorations({ ...state, ...view });
        let doc = state.EditorState.create({ doc: 'a\nemoji 😀\nz', extensions: runtime.extensions });
        doc = doc.update({ effects: [
            runtime.set.of({ layer: 'change', items: [{ id: 'c', key: 'k', kind: 'added', startLine: 2, endLine: 2 }] }),
            runtime.set.of({ layer: 'diagnostic', items: [{ id: 'd', severity: 'error', message: 'bad', startLine: 2, startCharacter: 6, endLine: 2, endCharacter: 8 }] }),
        ] }).state;
        doc = doc.update({ changes: { from: 0, insert: 'new\n' } }).state;
        expect(runtime.items(doc, 'diagnostic')[0]).toMatchObject({ startLine: 3, startCharacter: 6, endLine: 3, endCharacter: 8 });
        doc = doc.update({ changes: { from: doc.doc.line(3).from, to: doc.doc.line(4).from } }).state;
        expect(runtime.items(doc, 'change')[0]).toMatchObject({ startLine: 3, endLine: 3 });
        doc = doc.update({ effects: runtime.set.of({ layer: 'blame', items: [{ id: 'c', startLine: 1, lineCount: 1, runId: 'run' }] }) }).state;
        doc = doc.update({ effects: runtime.remove.of({ layer: 'change', id: 'c' }) }).state;
        expect(runtime.items(doc, 'change')).toEqual([]);
        expect(runtime.items(doc, 'blame')).toEqual([{ id: 'c', startLine: 1, lineCount: 1, runId: 'run' }]);
    });
    it('distinguishes deletion before the first line from deletion after that line when the anchor line splits', () => {
        const runtime = createCodeMirrorDecorations({ ...state, ...view });
        let doc = state.EditorState.create({ doc: 'anchor\nlast', extensions: runtime.extensions });
        doc = doc.update({ effects: runtime.set.of({ layer: 'change', items: [
            { id: 'bof', key: 'bof', kind: 'deleted', startLine: 1, endLine: 1, anchor: 'before' },
            { id: 'after', key: 'after', kind: 'deleted', startLine: 1, endLine: 1, anchor: 'after' },
        ] }) }).state;
        doc = doc.update({ changes: { from: 3, insert: '\n' } }).state;
        expect(runtime.items(doc, 'change')).toEqual([
            { id: 'bof', key: 'bof', kind: 'deleted', startLine: 1, endLine: 1, anchor: 'before' },
            { id: 'after', key: 'after', kind: 'deleted', startLine: 2, endLine: 2, anchor: 'after' },
        ]);
    });
});
