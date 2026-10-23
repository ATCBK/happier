import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const postMessageSpy = vi.fn();
let lastWebViewProps: any = null;
const unistylesState = vi.hoisted(() => ({
    themeOverride: {
        dark: true,
        colors: {
            syntax: {
                keyword: '#ff79c6',
            },
        },
    },
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Platform: { OS: 'ios', select: (options: Record<string, unknown>) => options.ios ?? options.native ?? options.default },
                    PixelRatio: {
                        getFontScale: () => 1,
                    },
                }
    );
});

vi.mock('react-native-webview', () => ({
    WebView: React.forwardRef((props: any, ref: any) => {
        lastWebViewProps = props;
        if (ref) {
            ref.current = {
                postMessage: postMessageSpy,
            };
        }
        return React.createElement('WebView', props, props.children);
    }),
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const { createThemeFixture } = await import('@/dev/testkit/fixtures/themeFixtures');
    const base = await createUnistylesMock();
    const baseRt = base.useUnistyles().rt;
    return {
        ...base,
        useUnistyles: () => ({
            theme: createThemeFixture(unistylesState.themeOverride),
            rt: baseRt,
        }),
    };
});

import { CodeMirrorWebViewSurface } from './CodeMirrorWebViewSurface.native';
import { renderScreen } from '@/dev/testkit';
import type { CodeEditorHandle } from '../codeEditorTypes';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';


function emitEnvelope(envelope: any) {
    if (!lastWebViewProps?.onMessage) throw new Error('WebView onMessage missing');
    lastWebViewProps.onMessage({ nativeEvent: { data: JSON.stringify(envelope) } });
}

function readRequestDocRequestIdFromPostedMessages(callStartIndex: number): string {
    for (const call of postMessageSpy.mock.calls.slice(callStartIndex)) {
        const raw = call?.[0];
        if (typeof raw !== 'string') continue;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') continue;
            if (parsed.type !== 'requestDoc') continue;
            const payload = (parsed as any).payload;
            const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
            if (requestId) return requestId;
        } catch {
            // ignore
        }
    }
    throw new Error('requestDoc envelope not found in posted messages');
}

function findPostedInitPayload(callStartIndex: number): any {
    for (const call of postMessageSpy.mock.calls.slice(callStartIndex)) {
        const raw = call?.[0];
        if (typeof raw !== 'string') continue;
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') continue;
            if (parsed.type !== 'init') continue;
            return (parsed as any).payload ?? null;
        } catch {
            // ignore
        }
    }
    return null;
}

describe('CodeMirrorWebViewSurface (native)', () => {
    it('forwards the configured editor save chord through the canonical host dispatcher', async () => {
        postMessageSpy.mockClear();
        const save = vi.fn();
        const { storage } = await import('@/sync/domains/state/storage');
        const previous = storage.getState().settings;
        try {
            storage.setState({ settings: { ...previous, keyboardShortcutsV2Enabled: true } });
            await renderScreen(<KeyboardShortcutProvider handlers={{ 'files.editor.save': save }}>
                <CodeMirrorWebViewSurface resetKey="save-shortcut" value="one" language="text" onChange={vi.fn()} />
            </KeyboardShortcutProvider>);
            emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
            const configs = postMessageSpy.mock.calls.map(([raw]) => JSON.parse(String(raw))).filter(message => message.type === 'keyboard.config');
            expect(configs.at(-1)?.payload.signatures).toContain('s|shift=false|ctrl=false|meta=true|alt=false');
            emitEnvelope({ v: 1, type: 'keyboard.shortcut', payload: { key: 's', code: 'KeyS', modifiers: { shift: false, ctrl: false, meta: true, alt: false }, repeat: false } });
            expect(save).toHaveBeenCalledOnce();
        } finally {
            await act(async () => { storage.setState({ settings: previous }); });
        }
    });
    it('consumes pointer, activation and cursor bridge events through the canonical handle and ignores malformed positions', async () => {
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<CodeMirrorWebViewSurface ref={ref} resetKey="intelligence" value="one" language="text" onChange={vi.fn()} />);
        expect(ref.current!.getCursorPosition!()).toBeNull();
        const pointer = vi.fn();
        const activate = vi.fn();
        const stopPointer = ref.current!.onPointerPosition!(pointer);
        const stopActivate = ref.current!.onActivatePosition!(activate);
        emitEnvelope({ v: 1, type: 'cursor', payload: { line: 2, character: 3 } });
        expect(ref.current!.getCursorPosition!()).toEqual({ line: 2, character: 3 });
        emitEnvelope({ v: 1, type: 'pointer', payload: { line: 2, character: 3, rect: { x: 10, y: 20, width: 0, height: 22 } } });
        expect(pointer).toHaveBeenLastCalledWith({ line: 2, character: 3, rect: { x: 10, y: 20, width: 0, height: 22 } });
        emitEnvelope({ v: 1, type: 'activate', payload: { line: 2, character: 3 } });
        expect(activate).toHaveBeenLastCalledWith({ line: 2, character: 3 });
        emitEnvelope({ v: 1, type: 'cursor', payload: { line: 0, character: -1 } });
        expect(ref.current!.getCursorPosition!()).toEqual({ line: 2, character: 3 });
        emitEnvelope({ v: 1, type: 'pointer', payload: null });
        expect(pointer).toHaveBeenLastCalledWith(null);
        stopPointer(); stopActivate();
        pointer.mockClear(); activate.mockClear();
        emitEnvelope({ v: 1, type: 'activate', payload: { line: 2, character: 3 } });
        emitEnvelope({ v: 1, type: 'pointer', payload: null });
        expect(pointer).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
    });
    it('exposes bridge selection changes and clears the snapshot when its document is replaced', async () => {
        const ref = React.createRef<CodeEditorHandle>();
        const screen = await renderScreen(<CodeMirrorWebViewSurface ref={ref} resetKey="selection" value="one\ntwo" language="text" onChange={vi.fn()} />);
        expect(ref.current?.getSelection?.()).toBeNull();
        const listener = vi.fn();
        const unsubscribe = ref.current!.subscribeSelection!(listener);
        const selection = { startLine: 1, endLine: 2, text: 'ne\ntw', rect: { x: 5, y: 8, width: 0, height: 18 } };
        emitEnvelope({ v: 1, type: 'selection', payload: selection });
        expect(ref.current!.getSelection!()).toEqual({ ...selection, collapsed: false });
        expect(listener).toHaveBeenCalledTimes(1);
        await screen.update(<CodeMirrorWebViewSurface ref={ref} resetKey="new-file" value="elsewhere" language="text" onChange={vi.fn()} />);
        expect(ref.current!.getSelection!()).toBeNull();
        unsubscribe();
        listener.mockClear();
        emitEnvelope({ v: 1, type: 'selection', payload: selection });
        expect(listener).not.toHaveBeenCalled();
    });
    it('answers line and position geometry from the WebView, so a host overlay can follow the text', async () => {
        postMessageSpy.mockClear();
        const ref = React.createRef<CodeEditorHandle>();
        const screen = await renderScreen(<CodeMirrorWebViewSurface ref={ref} resetKey="geometry" value="one\ntwo\nthree" language="text" onChange={vi.fn()} />);
        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        const listener = vi.fn();
        ref.current!.subscribeSelection!(listener);
        // Unknown geometry is asked for, never guessed.
        expect(ref.current!.getLineRect!(2)).toBeNull();
        expect(ref.current!.getPositionRect!(3, 5)).toBeNull();
        const watched = postMessageSpy.mock.calls.map(([raw]) => JSON.parse(raw)).filter((envelope) => envelope.type === 'geometry.watch').at(-1);
        expect(watched?.payload.positions).toEqual([{ line: 2, character: null }, { line: 3, character: 5 }]);
        emitEnvelope({ v: 1, type: 'geometry', payload: { items: [
            { line: 2, character: null, rect: { x: 40, y: 20, width: 300, height: 18 } },
            { line: 3, character: 5, rect: { x: 82, y: 38, width: 0, height: 18 } },
        ] } });
        expect(ref.current!.getLineRect!(2)).toEqual({ x: 40, y: 20, width: 300, height: 18 });
        expect(ref.current!.getPositionRect!(3, 5)).toEqual({ x: 82, y: 38, width: 0, height: 18 });
        expect(listener).toHaveBeenCalled();
        // A line scrolled out of the editor answers null again.
        emitEnvelope({ v: 1, type: 'geometry', payload: { items: [{ line: 2, character: null, rect: null }] } });
        expect(ref.current!.getLineRect!(2)).toBeNull();
        // A new document starts with no geometry.
        await screen.update(<CodeMirrorWebViewSurface ref={ref} resetKey="geometry-2" value="other" language="text" onChange={vi.fn()} />);
        expect(ref.current!.getPositionRect!(3, 5)).toBeNull();
        await screen.unmount();
    });
    it('reveals after document initialization and publishes engine history without rerendering its host', async () => {
        postMessageSpy.mockClear();
        const ref = React.createRef<CodeEditorHandle>();
        const onReady = vi.fn();
        await renderScreen(<CodeMirrorWebViewSurface ref={ref} resetKey="commands" value="one\ntwo" language="text" onChange={vi.fn()} initialLine={2} onReady={onReady} />);
        const listener = vi.fn();
        const unsubscribe = ref.current!.subscribeHistory(listener);
        expect(listener).toHaveBeenLastCalledWith({ canUndo: false, canRedo: false });
        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        expect(findPostedInitPayload(0)).toMatchObject({ reveal: { line: 2, behavior: 'instant' } });
        emitEnvelope({ v: 1, type: 'editor.ready', payload: {} });
        expect(onReady).toHaveBeenCalled();
        ref.current!.runCommand({ insert: '{}' });
        expect(JSON.parse(postMessageSpy.mock.calls.at(-1)![0])).toEqual({ v: 1, type: 'command', payload: { command: { insert: '{}' } } });
        emitEnvelope({ v: 1, type: 'history.state', payload: { canUndo: true, canRedo: false } });
        expect(listener).toHaveBeenLastCalledWith({ canUndo: true, canRedo: false });
        unsubscribe();
        listener.mockClear();
        emitEnvelope({ v: 1, type: 'history.state', payload: { canUndo: false, canRedo: true } });
        expect(listener).not.toHaveBeenCalled();
    });
    it('queues decoration layers until ready and reports the engine-tracked pressed range', async () => {
        postMessageSpy.mockClear();
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<CodeMirrorWebViewSurface ref={ref} resetKey="markers" value="one\ntwo" language="text" onChange={vi.fn()} />);
        expect(ref.current).toHaveProperty('setDecorations', expect.any(Function));
        const marker = { id: 'unit', key: 'content', kind: 'modified' as const, startLine: 2, endLine: 2, removedLines: ['before'] };
        ref.current!.setDecorations!('change', [marker]);
        const pressed = vi.fn();
        const unsubscribe = ref.current!.onDecorationPress!(pressed);
        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        expect(postMessageSpy.mock.calls.map(([raw]) => JSON.parse(String(raw)))).toContainEqual({ v: 1, type: 'decorations.set', payload: { layer: 'change', items: [marker] } });
        emitEnvelope({ v: 1, type: 'decorations.press', payload: { layer: 'change', item: { ...marker, startLine: 3, endLine: 3 } } });
        expect(pressed).toHaveBeenLastCalledWith('change', { ...marker, startLine: 3, endLine: 3 });
        unsubscribe();
        pressed.mockClear();
        emitEnvelope({ v: 1, type: 'decorations.press', payload: { layer: 'change', item: marker } });
        expect(pressed).not.toHaveBeenCalled();
    });
    it('removes a queued marker before readiness and forwards a live single-marker removal', async () => {
        postMessageSpy.mockClear();
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<CodeMirrorWebViewSurface ref={ref} resetKey="remove-markers" value="one\ntwo" language="text" onChange={vi.fn()} />);
        const first = { id: 'first', key: 'first', kind: 'modified' as const, startLine: 1, endLine: 1 };
        const second = { ...first, id: 'second', key: 'second', startLine: 2, endLine: 2 };
        ref.current!.setDecorations('change', [first, second]);
        ref.current!.removeDecoration('change', first.id);
        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        expect(postMessageSpy.mock.calls.map(([raw]) => JSON.parse(String(raw))))
            .toContainEqual({ v: 1, type: 'decorations.set', payload: { layer: 'change', items: [second] } });
        ref.current!.removeDecoration('change', second.id);
        expect(JSON.parse(String(postMessageSpy.mock.calls.at(-1)![0])))
            .toEqual({ v: 1, type: 'decorations.remove', payload: { layer: 'change', id: second.id } });
    });
    it('queues a travelling query until ready and publishes engine status through the existing handle', async () => {
        postMessageSpy.mockClear();
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
            ref, resetKey: 'find', value: 'one\r\ntwo\\n', language: 'plaintext', onChange: vi.fn(),
        }));
        ref.current?.find?.seed('\\n', { matchCase: true, regex: false }, { line: 2, column: 4 });
        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        const posted = postMessageSpy.mock.calls.map(([raw]) => JSON.parse(String(raw)));
        expect(posted.at(-1)).toEqual({ v: 1, type: 'find.set', payload: {
            query: '\\n', options: { matchCase: true, regex: false }, target: { line: 2, column: 4 },
        } });
        const listener = vi.fn();
        const unsubscribe = ref.current!.find!.subscribe(listener);
        emitEnvelope({ v: 1, type: 'find.status', payload: {
            query: '\\n', options: { matchCase: true, regex: false },
            status: { kind: 'results', current: 1, total: 1, coverage: 'complete' },
        } });
        expect(ref.current!.find!.getSnapshot()).toEqual({ query: '\\n', options: { matchCase: true, regex: false },
            status: { kind: 'results', current: 1, total: 1, coverage: 'complete' },
        });
        expect(listener).toHaveBeenCalled();
        ref.current!.find!.set('two', { matchCase: false, regex: false });
        emitEnvelope({ v: 1, type: 'find.status', payload: {
            query: '\\n', options: { matchCase: true, regex: false },
            status: { kind: 'results', current: 1, total: 1, coverage: 'complete' },
        } });
        expect(ref.current!.find!.getSnapshot().status).toEqual({ kind: 'searching', total: 0 });
        unsubscribe();
        ref.current!.find!.close();
        expect(ref.current!.find!.isOpen()).toBe(false);
    });
    beforeEach(() => {
        unistylesState.themeOverride = {
            dark: true,
            colors: {
                syntax: {
                    keyword: '#ff79c6',
                },
            },
        };
    });

    it('exposes imperative handle and can flush current doc via request/response', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const ref = React.createRef<any>();

        await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
                    ref,
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange: vi.fn(),
                    changeDebounceMs: 10,
                }));

        expect(ref.current).toBeTruthy();
        expect(typeof ref.current.getValue).toBe('function');
        expect(typeof ref.current.flushPendingChange).toBe('function');

        // Editor reports ready; host sends init.
        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        expect(postMessageSpy).toHaveBeenCalled();

        // Editor emits a debounced change update.
        emitEnvelope({ v: 1, type: 'docChanged', payload: { doc: 'hello world' } });
        expect(ref.current.getValue()).toBe('hello world');

        // Flush should request the doc snapshot and resolve once received.
        const callCountBeforeFlush = postMessageSpy.mock.calls.length;
        const flushPromise = ref.current.flushPendingChange();
        expect(postMessageSpy).toHaveBeenCalled();

        // Respond with a snapshot (requestId matching is handled by the implementation).
        const requestId = readRequestDocRequestIdFromPostedMessages(callCountBeforeFlush);
        emitEnvelope({ v: 1, type: 'docSnapshot', payload: { requestId, doc: 'final' } });

        await flushPromise;
        expect(ref.current.getValue()).toBe('final');
    });

    it('re-sends init when readOnly changes after ready', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const screen = await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange: vi.fn(),
                    readOnly: false,
                }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        postMessageSpy.mockClear();

        await act(async () => {
            await screen.update(
                React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange: vi.fn(),
                    readOnly: true,
                }),
            );
        });

        expect(findPostedInitPayload(0)).toEqual(expect.objectContaining({
            doc: 'hello',
            readOnly: true,
        }));
    });

    it('re-sends init with the latest editor document when readOnly changes before parent value catches up', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        postMessageSpy.mockClear();

        emitEnvelope({ v: 1, type: 'docChanged', payload: { doc: 'hello world' } });
        expect(onChange).toHaveBeenCalledWith('hello world');
        emitEnvelope({ v: 1, type: 'docChanged', payload: { doc: 'hello', history: 'undo' } });
        expect(onChange).toHaveBeenLastCalledWith('hello', { history: 'undo' });
        emitEnvelope({ v: 1, type: 'docChanged', payload: { doc: 'hello world', history: 'redo' } });
        expect(onChange).toHaveBeenLastCalledWith('hello world', { history: 'redo' });

        await act(async () => {
            await screen.update(
                React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: true,
                }),
            );
        });

        expect(findPostedInitPayload(0)).toEqual(expect.objectContaining({
            doc: 'hello world',
            readOnly: true,
        }));
    });

    it('does not re-send init when accepting a doc change from the editor', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'test',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }));

        emitEnvelope({ v: 1, type: 'ready', payload: { ok: true } });
        postMessageSpy.mockClear();

        emitEnvelope({ v: 1, type: 'docChanged', payload: { doc: 'test 123' } });
        expect(onChange).toHaveBeenCalledWith('test 123');

        await act(async () => {
            await screen.update(
                React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'test 123',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }),
            );
        });

        expect(findPostedInitPayload(0)).toBeNull();
    });

    it('rebuilds WebView HTML when syntax theme colors change', async () => {
        postMessageSpy.mockClear();
        lastWebViewProps = null;

        const screen = await renderScreen(React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'const message = \"hello\";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }));

        const firstHtml = lastWebViewProps?.source?.html;
        expect(firstHtml).toContain('#ff79c6');

        unistylesState.themeOverride = {
            dark: true,
            colors: {
                syntax: {
                    keyword: '#00ffaa',
                },
            },
        };

        await act(async () => {
            await screen.update(
                React.createElement(CodeMirrorWebViewSurface, {
                    resetKey: '1',
                    value: 'const message = \"hello\";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }),
            );
        });

        expect(lastWebViewProps?.source?.html).toContain('#00ffaa');
        expect(lastWebViewProps?.source?.html).not.toBe(firstHtml);
    });
});
