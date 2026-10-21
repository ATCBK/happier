/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as commands from '@codemirror/commands';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import type { EditorDecoration, EditorDecorationLayer, TextEditorHandle } from './codeEditorTypes';
import { buildEditorChangeMarkers } from './editorChangeMarkers';
import { useEditorChangeMarkers } from './useEditorChangeMarkers';
import { createCodeMirrorDecorations } from './bridge/codeMirrorDecorations';
import { minimalCodeEditorEdit } from './codeEditorDocumentEdit';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
afterEach(standardCleanup);

describe('change marker admission', () => {
    it('reconciles a discarded change after undo and redo without losing other tracked marks', async () => {
        const markers = buildEditorChangeMarkers('a.ts', null, '@@ -1 +1,2 @@\n-old\n+saved\n+added\n@@ -4 +5 @@\n-last\n+changed\n');
        const runtime = createCodeMirrorDecorations({ ...state, ...view });
        const seedText = 'saved\nadded\nmiddle\nother\nchanged\n';
        let doc = state.EditorState.create({ doc: `${seedText}my note\n`, extensions: [runtime.extensions, commands.history()] });
        let controller!: ReturnType<typeof useEditorChangeMarkers>;
        let press: ((layer: EditorDecorationLayer, item: EditorDecoration) => void) | undefined;
        // Only the editor's mounted DOM/handle is adapted; tracked ranges and text edits are real.
        const engine = {
            getValue: () => doc.doc.toString(),
            flushPendingChange: async () => {},
            setDecorations: (layer: EditorDecorationLayer, items: readonly EditorDecoration[]) => {
                doc = doc.update({ effects: runtime.set.of({ layer, items }) }).state;
            },
            removeDecoration: (layer: EditorDecorationLayer, id: string) => {
                doc = doc.update({ effects: runtime.remove.of({ layer, id }) }).state;
            },
            onDecorationPress: (callback: NonNullable<typeof press>) => { press = callback; return () => { press = undefined; }; },
            runCommand: (command: Parameters<NonNullable<TextEditorHandle['runCommand']>>[0]) => {
                if (typeof command === 'object' && 'replaceDocument' in command) {
                    const change = minimalCodeEditorEdit(doc.doc.toString(), command.replaceDocument);
                    if (change) doc = doc.update({ changes: change, annotations: commands.isolateHistory.of('full'), userEvent: 'input' }).state;
                } else if (command === 'undo' || command === 'redo') {
                    commands[command]({ state: doc, dispatch: transaction => {
                        doc = transaction.state;
                        controller.onDocumentChange(doc.doc.toString(), { history: command });
                    } });
                }
            },
        };
        function Markers() {
            controller = useEditorChangeMarkers({ editor: engine, active: true, seedKey: 'saved-v1', markers, seedText });
            return null;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Markers /></KeyboardShortcutProvider>);
        engine.setDecorations('diagnostic', [{ id: markers[0]!.id, severity: 'warning', message: 'note', startLine: 6, startCharacter: 0, endLine: 6, endCharacter: 2 }]);
        const discarded = runtime.items(doc, 'change')[0]!;
        await act(async () => { press?.('change', discarded); });
        await act(async () => { expect(await controller.revertInDraft(controller.selected!)).toMatchObject({ ok: true }); });
        expect(engine.getValue()).toBe('old\nmiddle\nother\nchanged\nmy note\n');
        expect(controller.selected).toBeNull();
        expect(runtime.items(doc, 'change')).toMatchObject([{ id: markers[1]!.id, startLine: 4, endLine: 4 }]);
        expect(runtime.items(doc, 'diagnostic')).toMatchObject([{ id: discarded.id, startLine: 5 }]);
        // A gutter press after Discard can only address the remaining engine-tracked change.
        const atDiscardedLine = runtime.items(doc, 'change').find(item => item.startLine === 1);
        await act(async () => { if (atDiscardedLine) press?.('change', atDiscardedLine); });
        expect(controller.selected).toBeNull();
        // Undoing unrelated typing first must not resurrect the still-reverted change.
        doc = doc.update({ changes: { from: doc.doc.length, insert: 'later note\n' }, annotations: commands.isolateHistory.of('full'), userEvent: 'input' }).state;
        await act(async () => { engine.runCommand('undo'); });
        expect(runtime.items(doc, 'change')).toMatchObject([{ id: markers[1]!.id, startLine: 4 }]);
        await act(async () => { engine.runCommand('undo'); });
        expect(engine.getValue()).toBe(`${seedText}my note\n`);
        expect(runtime.items(doc, 'change')).toMatchObject([
            { id: markers[0]!.id, startLine: 1, endLine: 2 },
            { id: markers[1]!.id, startLine: 5, endLine: 5 },
        ]);
        await act(async () => { press?.('change', runtime.items(doc, 'change')[0]!); });
        expect(controller.selected).toMatchObject({ id: markers[0]!.id, startLine: 1, endLine: 2 });
        await act(async () => { engine.runCommand('redo'); });
        expect(controller.selected).toBeNull();
        expect(runtime.items(doc, 'change')).toMatchObject([{ id: markers[1]!.id, startLine: 4, endLine: 4 }]);
        await act(async () => { press?.('change', runtime.items(doc, 'change')[0]!); });
        expect(controller.selected?.id).toBe(markers[1]!.id);
        // A refused revert must keep its mark and the person's edited text.
        doc = doc.update({ changes: { from: doc.doc.line(4).from, insert: 'mine ' } }).state;
        await act(async () => { expect(await controller.revertInDraft(controller.selected!)).toMatchObject({ ok: false, reason: 'moved_on' }); });
        expect(runtime.items(doc, 'change')).toHaveLength(1);
        expect(engine.getValue()).toContain('mine changed');
    });
    it('publishes pending engine text before opening dirty actions and retires an outgoing flush', async () => {
        const marker = buildEditorChangeMarkers('a.ts', null, '@@ -1 +1 @@\n-old\n+saved\n')[0]!;
        const markers = [marker];
        let text = 'saved\n';
        let publishedText = text;
        let openedDirty: boolean | null = null;
        let active = true;
        let flush = createDeferred<void>();
        let press: ((layer: EditorDecorationLayer, item: EditorDecoration) => void) | undefined;
        // The real host receives text only when the engine flushes its existing debounce.
        const engine: TextEditorHandle = {
            getValue: () => text,
            flushPendingChange: async () => { await flush.promise; publishedText = text; },
            setDecorations: () => {},
            onDecorationPress: callback => { press = callback; return () => { press = undefined; }; },
        };
        let controller!: ReturnType<typeof useEditorChangeMarkers>;
        function Markers() {
            controller = useEditorChangeMarkers({ editor: engine, active, seedKey: 'saved-v1', markers });
            if (controller.selected) openedDirty = publishedText !== 'saved\n';
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Markers /></KeyboardShortcutProvider>);
        text = 'saved\nmy pending edit\n';
        await act(async () => { press?.('change', marker); });
        expect(controller.selected).toBeNull();
        expect(openedDirty).toBeNull();
        await act(async () => { flush.resolve(); });
        expect(controller.selected).toMatchObject({ key: marker.key });
        expect(openedDirty).toBe(true);

        await act(async () => { controller.close(); });
        flush = createDeferred<void>();
        await act(async () => { press?.('change', marker); });
        active = false;
        await screen.update(<KeyboardShortcutProvider handlers={{}}><Markers /></KeyboardShortcutProvider>);
        await act(async () => { flush.resolve(); });
        expect(controller.selected).toBeNull();
    });
});
