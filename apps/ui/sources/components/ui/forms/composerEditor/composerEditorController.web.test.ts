/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { undo } from '@tiptap/pm/history';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { createComposerEditorController, type ComposerEditorControllerOptions } from './composerEditorController.web';
import type { ComposerEditorReference } from './composerEditorTypes';

const instances: ReturnType<typeof createComposerEditorController>[] = [];
afterEach(() => { for (const instance of instances.splice(0)) instance.destroy(); document.body.replaceChildren(); });
function reference(ref = 'session:auth', label = 'Auth', start = 0): ComposerEditorReference {
    const token = formatInlineReferenceTokenV1({ ref, label });
    return { ref, label, token, kind: 'happier.session', start, end: start + token.length, readableMarker: `@Session "${label}"` };
}
function create(options: ComposerEditorControllerOptions) {
    const element = document.createElement('div');
    document.body.append(element);
    const controller = createComposerEditorController(element, options);
    instances.push(controller);
    return controller;
}
function key(controller: ReturnType<typeof create>, value: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
    controller.editor.view.dom.dispatchEvent(event);
    return event;
}
function clipboard(controller: ReturnType<typeof create>, kind: 'paste' | 'copy' | 'cut', text: string) {
    const event = new Event(kind, { bubbles: true, cancelable: true });
    const setData = vi.fn();
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text, setData, files: [], items: [] } });
    controller.editor.view.dom.dispatchEvent(event);
    return setData;
}

describe('real DOM composer editing', () => {
    it('selects on first Backspace, deletes on second, and undo restores the exact typed occurrence', () => {
        const ref = reference();
        const controller = create({ text: ref.token, references: [ref] });
        key(controller, 'Backspace');
        expect(controller.read().text).toBe(ref.token);
        expect(controller.read().selection).toEqual({ start: 0, end: ref.end });
        key(controller, 'Backspace');
        expect(controller.read().text).toBe('');
        undo(controller.editor.state, controller.editor.view.dispatch);
        expect(controller.read().references).toEqual([ref]);
        controller.setSelection({ start: 0, end: 0 });
        key(controller, 'Delete');
        expect(controller.read().text).toBe('');
    });

    it('copies readable markers, cuts atomically, and pasted tokens remain plain', () => {
        const ref = reference();
        const controller = create({ text: ref.token, references: [ref] });
        controller.setSelection({ start: 0, end: ref.end });
        expect(clipboard(controller, 'copy', '')).toHaveBeenCalledWith('text/plain', '@Session "Auth"');
        expect(clipboard(controller, 'cut', '')).toHaveBeenCalledWith('text/plain', '@Session "Auth"');
        expect(controller.read().text).toBe('');
        clipboard(controller, 'paste', ref.token);
        expect(controller.read().text).toBe(ref.token);
        expect(controller.read().references).toEqual([]);
        expect(controller.editor.view.dom.querySelector('[data-composer-chip]')).toBeNull();
    });

    it('steps across a chip in one arrow press in composer-text offsets', () => {
        const ref = reference();
        const controller = create({ text: `${ref.token}x`, references: [ref] });
        controller.setSelection({ start: ref.end, end: ref.end });
        key(controller, 'ArrowLeft');
        expect(controller.read().selection).toEqual({ start: 0, end: 0 });
        key(controller, 'ArrowRight');
        expect(controller.read().selection).toEqual({ start: ref.end, end: ref.end });
    });

    it('keeps text entered during composition when the deferred controlled echo was unchanged', async () => {
        const ref = reference();
        const controller = create({ text: ref.token, references: [ref] });
        controller.editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        controller.update({ text: ref.token, references: [ref] });
        controller.editor.view.dispatch(controller.editor.state.tr.insertText('日', 1));
        controller.editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        await new Promise<void>(resolve => queueMicrotask(resolve));
        expect(controller.read().text).toBe(`日${ref.token}`);
        expect(controller.read().references[0].start).toBe(1);
    });

    it('preserves differently labelled occurrences of the same identity through delete and undo', () => {
        const first = reference();
        const second = reference('session:auth', 'Renamed', first.end + 1);
        const text = first.token + ' ' + second.token;
        const controller = create({ text, references: [first, second] });
        key(controller, 'Backspace'); key(controller, 'Backspace');
        undo(controller.editor.state, controller.editor.view.dispatch);
        expect(controller.read().text).toBe(text);
        expect(controller.read().references).toEqual([first, second]);
    });

    it('preserves a bound chip when dictation replaces text before it through the input handle', () => {
        const ref = reference('session:auth', 'Auth', 4);
        const controller = create({ text: `old ${ref.token}`, references: [ref] });
        controller.setSelection({ start: 0, end: 3 });
        controller.setTextAndSelection(`new words ${ref.token}`, { start: 9, end: 9 });
        expect(controller.read().text).toBe(`new words ${ref.token}`);
        expect(controller.read().references).toEqual([{ ...ref, start: 10, end: ref.end + 6 }]);
        undo(controller.editor.state, controller.editor.view.dispatch);
        expect(controller.read().references).toEqual([ref]);
    });

    it('defers external updates and ignores keyCode 229 during IME composition', async () => {
        const ref = reference();
        const onKeyDown = vi.fn();
        const controller = create({ text: ref.token, references: [ref], onKeyDown });
        controller.editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        controller.update({ text: `日${ref.token}`, references: [{ ...ref, start: 1, end: ref.end + 1 }] });
        expect(controller.read().text).toBe(ref.token);
        key(controller, 'Backspace', { keyCode: 229, isComposing: true });
        expect(onKeyDown).not.toHaveBeenCalled();
        controller.editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        await new Promise<void>(resolve => queueMicrotask(resolve));
        expect(controller.read().text).toBe(`日${ref.token}`);
        expect(controller.read().references).toHaveLength(1);
    });

    it('does not let undo resurrect an image reference after its tray item was removed', () => {
        const ref = reference('attachment:picture', 'Image', 1);
        const controller = create({ text: `x${ref.token}`, references: [ref], attachmentIds: ['picture'] });
        key(controller, 'Backspace'); key(controller, 'Backspace');
        controller.update({ text: 'x', references: [], attachmentIds: [] });
        undo(controller.editor.state, controller.editor.view.dispatch);
        expect(controller.read().text).toBe('x');
        expect(controller.read().references).toEqual([]);
    });

    it('removes only the exact chip through its node-view action, retaining tray custody and undo', () => {
        const ref = reference('attachment:picture', 'Image');
        let remove: unknown;
        const controller = create({ text: ref.token, references: [ref], attachmentIds: ['picture'],
            renderChip: (...args) => {
                remove = (args as readonly unknown[])[3];
                return { update: () => {}, destroy: () => {} };
            },
        });
        expect(remove).toBeTypeOf('function');
        if (typeof remove === 'function') remove();
        expect(controller.read().text).toBe('');
        undo(controller.editor.state, controller.editor.view.dispatch);
        expect(controller.read().references).toEqual([ref]);
    });

    it('draws decorations in place and updates the drop caret without changing text or selection', () => {
        const controller = create({ text: 'hello', decorations: [{ start: 0, end: 5, treatment: 'code', label: 'Code' }] });
        const before = controller.read();
        expect(controller.editor.view.dom.querySelector('[data-composer-decoration="code"]')?.textContent).toBe('hello');
        controller.setDropCaret(2);
        expect(controller.editor.view.dom.querySelector('[data-composer-drop-caret]')).not.toBeNull();
        expect(controller.read()).toEqual(before);
        controller.setDropCaret(null);
        expect(controller.editor.view.dom.querySelector('[data-composer-drop-caret]')).toBeNull();
    });
});
