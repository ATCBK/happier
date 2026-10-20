import { describe, expect, it } from 'vitest';
import { selectEmbeddedKeyboardHandlers } from './embeddedKeyboard';

describe('embedded keyboard command boundary', () => {
    it('forwards editor Save and Ask alongside Find while terminals retain their Find-only boundary', () => {
        const find = () => {};
        const save = () => {};
        const ask = () => {};
        const handlers = { 'find.open': find, 'files.editor.save': save, 'editor.selection.ask': ask, 'composer.focus': () => {} };
        const editor = selectEmbeddedKeyboardHandlers(handlers, 'editor');
        expect(editor['find.open']).toBe(find);
        expect(editor['files.editor.save']).toBe(save);
        expect(editor['editor.selection.ask']).toBe(ask);
        expect(editor['composer.focus']).toBeUndefined();
        const terminal = selectEmbeddedKeyboardHandlers(handlers, 'find');
        expect(terminal['find.open']).toBe(find);
        expect(terminal['files.editor.save']).toBeUndefined();
        expect(terminal['editor.selection.ask']).toBeUndefined();
    });
});
