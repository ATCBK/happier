// @vitest-environment jsdom
import * as state from '@codemirror/state';
import * as view from '@codemirror/view';
import * as commands from '@codemirror/commands';
import * as language from '@codemirror/language';
import * as autocomplete from '@codemirror/autocomplete';
import * as search from '@codemirror/search';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCodeMirrorWebViewHtml } from './codemirrorWebViewHtml';

// Load the installed CodeMirror modules through the WebView's embedded-bundle ABI.
vi.mock('./codemirrorWebViewBundle.generated', () => ({ CODEMIRROR_WEBVIEW_BUNDLE_JS: '/* installed modules supplied by test */' }));

type Envelope = { v: number; type: string; payload: { doc?: string; requestId?: string; message?: string; status?: unknown } };

function bootBridge() {
    const messages: Envelope[] = [];
    document.body.innerHTML = '<div id="root"></div>';
    vi.stubGlobal('__CM6__', { ...state, ...view, ...commands, ...language, ...autocomplete, ...search });
    Object.defineProperty(window, 'ReactNativeWebView', {
        configurable: true,
        value: { postMessage: (raw: string) => messages.push(JSON.parse(raw)) },
    });
    const html = buildCodeMirrorWebViewHtml({
        theme: {
            backgroundColor: '#000', textColor: '#fff', dividerColor: '#333', lineNumberColor: '#777',
            activeLineColor: '#111', selectionColor: '#555', isDark: true,
            syntax: {
                defaultColor: '#fff', keywordColor: '#fff', stringColor: '#fff', commentColor: '#777',
                numberColor: '#fff', functionColor: '#fff',
            },
        },
        wrapLines: true,
        showLineNumbers: true,
        changeDebounceMs: 100,
        maxChunkBytes: 64_000,
    });
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
    if (!script) throw new Error('WebView bridge script missing');
    const documentListeners = vi.spyOn(document, 'addEventListener');
    const windowListeners = vi.spyOn(window, 'addEventListener');
    new Function(script)();
    expect(messages).toEqual([{ v: 1, type: 'ready', payload: { ok: true } }]);
    const send = (type: string, payload: object) => window.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ v: 1, type, payload }),
    }));
    const getView = () => {
        const element = document.querySelector<HTMLElement>('.cm-editor');
        const editor = element ? view.EditorView.findFromDOM(element) : null;
        if (!editor) throw new Error('CodeMirror view missing');
        return editor;
    };
    const cleanup = () => {
        getView().destroy();
        for (const [type, listener] of documentListeners.mock.calls) {
            if (type === 'message') document.removeEventListener(type, listener);
        }
        for (const [type, listener] of windowListeners.mock.calls) {
            if (type === 'message') window.removeEventListener(type, listener);
        }
    };
    return { messages, send, getView, cleanup };
}

describe('native CodeMirror WebView line endings', () => {
    let cleanup: (() => void) | undefined;
    let restoreRangeGeometry: (() => void) | undefined;

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        // JSDOM has no layout engine; retain the real CodeMirror measurement path over a DOM boundary fixture.
        const descriptors = ['getClientRects', 'getBoundingClientRect'].map((name) => [name, Object.getOwnPropertyDescriptor(Range.prototype, name)] as const);
        Object.defineProperties(Range.prototype, {
            getClientRects: { configurable: true, value: () => [] },
            getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
        });
        restoreRangeGeometry = () => {
            for (const [name, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(Range.prototype, name, descriptor);
                else Reflect.deleteProperty(Range.prototype, name);
            }
        };
    });
    afterEach(() => {
        cleanup?.();
        cleanup = undefined;
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        Reflect.deleteProperty(window, 'ReactNativeWebView');
        restoreRangeGeometry?.();
        restoreRangeGeometry = undefined;
    });

    it('publishes the current line at a caret and exact CRLF selection text with whole-line anchor bounds', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'first\r\nsecond\r\nthird' });
        const selections = () => bridge.messages.filter((message) => message.type === 'selection');
        expect(selections().at(-1)?.payload).toMatchObject({ startLine: 1, endLine: 1, text: 'first' });
        const editor = bridge.getView();
        editor.dispatch({ selection: { anchor: 2, head: editor.state.doc.line(3).from } });
        expect(selections().at(-1)?.payload).toMatchObject({ startLine: 1, endLine: 2, text: 'rst\r\nsecond\r\n' });
        editor.dispatch({ selection: { anchor: editor.state.doc.line(2).from + 1 } });
        expect(selections().at(-1)?.payload).toMatchObject({ startLine: 2, endLine: 2, text: 'second' });
        editor.dispatch({ changes: { from: editor.state.doc.line(2).to, insert: '!' } });
        expect(selections().at(-1)?.payload).toMatchObject({ startLine: 2, endLine: 2, text: 'second!' });
    });

    it('forwards only configured editor shortcuts before native CodeMirror handlers and preserves composing input', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'one\ntwo' });
        bridge.send('keyboard.config', { signatures: ['i|shift=false|ctrl=false|meta=true|alt=false'] });
        const editor = bridge.getView();
        const sendKey = (init: KeyboardEventInit) => {
            const event = new KeyboardEvent('keydown', { key: 'i', code: 'KeyI', bubbles: true, cancelable: true, ...init });
            editor.contentDOM.dispatchEvent(event);
            return event;
        };
        expect(sendKey({ metaKey: true }).defaultPrevented).toBe(true);
        const shortcut = bridge.messages.filter((message) => message.type === 'keyboard.shortcut');
        expect(shortcut).toHaveLength(1);
        expect(shortcut[0].payload).toMatchObject({ key: 'i', code: 'KeyI', modifiers: { shift: false, ctrl: false, meta: true, alt: false } });
        expect(sendKey({ metaKey: true, isComposing: true }).defaultPrevented).toBe(false);
        bridge.send('keyboard.config', { signatures: [] });
        expect(sendKey({ metaKey: true }).defaultPrevented).toBe(false);
        expect(bridge.messages.filter((message) => message.type === 'keyboard.shortcut')).toHaveLength(1);
    });

    it('bridges pointer, activation and cursor positions from the real editor in UTF-16', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'one\n😀 symbol' });
        const editor = bridge.getView();
        editor.dispatch({ selection: { anchor: 7 } });
        expect(bridge.messages).toContainEqual({ v: 1, type: 'cursor', payload: { line: 2, character: 3 } });
        vi.spyOn(editor, 'posAtCoords').mockReturnValue(7);
        vi.spyOn(editor, 'coordsAtPos').mockReturnValue({ left: 10, right: 10, top: 20, bottom: 42 });
        editor.contentDOM.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 20 }));
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'pointer', payload: {
            line: 2, character: 3, rect: { x: 10, y: 20, width: 0, height: 22 },
        } });
        const click = new MouseEvent('mousedown', { bubbles: true, cancelable: true, metaKey: true, clientX: 10, clientY: 20 });
        editor.contentDOM.dispatchEvent(click);
        expect(click.defaultPrevented).toBe(true);
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'activate', payload: { line: 2, character: 3 } });
        editor.contentDOM.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }));
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'pointer', payload: null });
        const activations = bridge.messages.filter((message) => message.type === 'activate').length;
        editor.contentDOM.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, metaKey: true, button: 2, clientX: 10, clientY: 20 }));
        expect(bridge.messages.filter((message) => message.type === 'activate')).toHaveLength(activations);
    });

    it('executes accessory commands and whole-document replacement as one undoable edit, guarded during composition', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'one\ntwo\nthree' });
        bridge.send('reveal', { line: 2, select: true });
        const editor = bridge.getView();
        expect(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)).toBe('two');
        bridge.send('command', { command: { insert: 'TWO' } });
        expect(editor.state.doc.toString()).toBe('one\nTWO\nthree');
        bridge.send('command', { command: 'indent' });
        expect(editor.state.doc.line(2).text).toBe('  TWO');
        bridge.send('command', { command: 'outdent' });
        expect(editor.state.doc.line(2).text).toBe('TWO');
        bridge.send('command', { command: { replaceDocument: 'one\nSECOND\nthree' } });
        expect(editor.state.doc.toString()).toBe('one\nSECOND\nthree');
        bridge.send('command', { command: 'undo' });
        expect(editor.state.doc.toString()).toBe('one\nTWO\nthree');
        expect(bridge.messages).toContainEqual({ v: 1, type: 'history.state', payload: { canUndo: true, canRedo: true } });
        bridge.send('command', { command: 'redo' });
        expect(editor.state.doc.line(2).text).toBe('SECOND');
        Object.defineProperty(editor, 'composing', { configurable: true, value: true });
        bridge.send('command', { command: { insert: 'ignored' } });
        bridge.send('command', { command: 'undo' });
        expect(editor.state.doc.line(2).text).toBe('SECOND');
    });

    it('finds literal backslashes on the live CRLF document, seeds the addressed hit and preserves selection on close', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: '😀 first\\n\r\nsecond\\n\r\nthird\\n' });
        bridge.send('find.set', { query: '\\n', options: { matchCase: true, regex: false }, target: { line: 2, column: 7 } });
        const editor = bridge.getView();
        expect(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to)).toBe('\\n');
        expect(editor.state.doc.lineAt(editor.state.selection.main.from).number).toBe(2);
        expect(bridge.messages.at(-1)).toMatchObject({ type: 'find.status', payload: {
            status: { kind: 'results', current: 2, total: 3, coverage: 'complete' },
        } });
        expect(document.querySelector('.cm-search')).toBeNull();
        expect(document.querySelectorAll('.cm-searchMatch')).toHaveLength(3);
        expect(document.querySelectorAll('.cm-searchMatch-selected')).toHaveLength(1);

        bridge.send('find.step', { direction: 1 });
        expect(editor.state.doc.lineAt(editor.state.selection.main.from).number).toBe(3);
        expect(bridge.messages.at(-1)?.payload.status).toMatchObject({ current: 3, total: 3 });
        const selection = editor.state.selection;
        bridge.send('find.close', {});
        expect(editor.state.selection).toBe(selection);
        expect(bridge.messages.at(-1)?.payload.status).toEqual({ kind: 'idle' });
        bridge.send('requestDoc', { requestId: 'after-find' });
        expect(bridge.messages.at(-1)?.payload.doc).toBe('😀 first\\n\r\nsecond\\n\r\nthird\\n');
    });

    it('reports invalid regex and refreshes counts from edits before the host change debounce', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'one two' });
        bridge.send('find.set', { query: '[', options: { matchCase: false, regex: true } });
        expect(bridge.messages.at(-1)?.payload.status).toEqual({ kind: 'invalidPattern' });
        bridge.send('find.set', { query: 'one', options: { matchCase: false, regex: false } });
        bridge.getView().dispatch({ changes: { from: 7, insert: ' one' } });
        expect(bridge.messages.filter(message => message.type === 'find.status').at(-1)?.payload.status).toMatchObject({ kind: 'results', total: 2 });
    });

    it.each(['\r\n', '\r', '\n'])('preserves %j in snapshots, debounced changes and stale-host flushes', (separator) => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        const initial = `one${separator}two${separator}`;
        bridge.send('init', { doc: initial });
        bridge.send('requestDoc', { requestId: 'initial' });
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'docSnapshot', payload: { requestId: 'initial', doc: initial } });

        const editor = bridge.getView();
        editor.dispatch({ changes: { from: editor.state.doc.length, insert: `three${separator}` } });
        vi.advanceTimersByTime(100);
        const changed = `${initial}three${separator}`;
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'docChanged', payload: { doc: changed } });

        editor.dispatch({ selection: { anchor: 2 } });
        const beforeEcho = editor.state;
        bridge.send('setDoc', { doc: changed });
        expect(editor.state).toBe(beforeEcho);
        expect(editor.state.selection.main.anchor).toBe(2);

        editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'four' } });
        bridge.send('setDoc', { doc: changed });
        expect(bridge.messages.at(-1)).toEqual({ v: 1, type: 'docChanged', payload: { doc: `${changed}four` } });
        bridge.send('requestDoc', { requestId: 'latest' });
        expect(bridge.messages.at(-1)?.payload.doc).toBe(`${changed}four`);
    });

    it('detects the separator again when the host replaces the document', () => {
        const bridge = bootBridge();
        cleanup = bridge.cleanup;
        bridge.send('init', { doc: 'one\r\ntwo\r\n' });
        bridge.send('setDoc', { doc: 'alpha\rbeta\r' });
        bridge.send('requestDoc', { requestId: 'replacement' });
        expect(bridge.messages.at(-1)?.payload.doc).toBe('alpha\rbeta\r');
        const editor = bridge.getView();
        editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'gamma\r' } });
        vi.advanceTimersByTime(100);
        expect(bridge.messages.at(-1)?.payload.doc).toBe('alpha\rbeta\rgamma\r');
    });
});
