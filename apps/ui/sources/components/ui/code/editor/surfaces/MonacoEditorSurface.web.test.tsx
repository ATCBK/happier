import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const createModelSpy = vi.fn<(...args: unknown[]) => Record<string, unknown>>(() => ({
    getValue: (): string => '',
    setValue: () => {},
    dispose: () => {},
}));

const createEditorSpy = vi.fn<(...args: unknown[]) => Record<string, unknown>>(() => ({
    onDidChangeModelContent: () => ({ dispose: () => {} }),
    onDidBlurEditorText: () => ({ dispose: () => {} }),
    updateOptions: () => {},
    dispose: () => {},
}));
const defineThemeSpy = vi.fn();
const setThemeSpy = vi.fn();
const typescriptModeSpy = vi.fn();
const javascriptModeSpy = vi.fn();

const darkEditorTheme = {
    dark: true,
    colors: {
        border: { default: '#303030' },
        text: { primary: '#f8f8f2', secondary: '#cfcfcf', tertiary: '#8a8a8a' },
        surface: { base: '#151515', inset: '#1f1f1f', elevated: '#101010', selected: '#2a2a2a' },
        accent: { blue: '#58a6ff' },
        diff: { added: { border: '#3fb950' } },
        syntax: {
            default: '#f8f8f2',
            keyword: '#ff79c6',
            string: '#50fa7b',
            comment: '#6272a4',
            number: '#bd93f9',
            function: '#8be9fd',
        },
    },
};

const lightEditorTheme = {
    dark: false,
    colors: {
        border: { default: '#d0d7de' },
        text: { primary: '#24292f', secondary: '#57606a', tertiary: '#6e7781' },
        surface: { base: '#ffffff', inset: '#f6f8fa', elevated: '#ffffff', selected: '#ddf4ff' },
        accent: { blue: '#0969da' },
        diff: { added: { border: '#1a7f37' } },
        syntax: {
            default: '#24292f',
            keyword: '#cf222e',
            string: '#0a3069',
            comment: '#6e7781',
            number: '#0550ae',
            function: '#8250df',
        },
    },
};

type EditorThemeFixture = typeof darkEditorTheme | typeof lightEditorTheme;

const unistylesState = vi.hoisted(() => ({
    currentTheme: null as unknown as EditorThemeFixture,
}));
const monacoDom = vi.hoisted(() => ({ listeners: new Map<string, EventListener>() }));

function assertCallable(value: unknown, label: string): (...args: unknown[]) => unknown {
    if (typeof value !== 'function') throw new Error(`expected ${label} to be callable`);
    return value as (...args: unknown[]) => unknown;
}

/** The installed Monaco 0.55.1 boundary always includes both language-service defaults. */
function createMonacoLanguageServicesBoundary() {
    return { typescript: {
        typescriptDefaults: { setModeConfiguration: typescriptModeSpy },
        javascriptDefaults: { setModeConfiguration: javascriptModeSpy },
    } };
}

function setupMonacoGlobals() {
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).document = (globalThis as any).document ?? {};
    window.addEventListener ??= vi.fn();
    window.removeEventListener ??= vi.fn();

    (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
        if (typeof onOk === 'function') onOk();
    };
    (globalThis as any).window.monaco = {
        ...createMonacoLanguageServicesBoundary(),
        editor: {
            createModel: createModelSpy,
            create: createEditorSpy,
            defineTheme: defineThemeSpy,
            setTheme: setThemeSpy,
        },
    };
}

beforeEach(() => {
    createModelSpy.mockClear();
    createEditorSpy.mockClear();
    defineThemeSpy.mockClear();
    setThemeSpy.mockClear();
    typescriptModeSpy.mockClear();
    javascriptModeSpy.mockClear();
    monacoDom.listeners.clear();
    unistylesState.currentTheme = darkEditorTheme;
});

vi.mock('react-native', async () => {
    const React = await import('react');
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const View = React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({
            addEventListener: (type: string, listener: EventListener) => monacoDom.listeners.set(type, listener),
            removeEventListener: (type: string) => monacoDom.listeners.delete(type),
        }), []);
        return React.createElement('View', props, props.children);
    });
    return createReactNativeWebMock({
        View,
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const base = await createUnistylesMock();
    const baseRuntime = base.useUnistyles().rt;
    return {
        ...base,
        useUnistyles: () => ({ theme: unistylesState.currentTheme, rt: baseRuntime }),
    };
});

import { MonacoEditorSurface } from './MonacoEditorSurface.web';
import type { CodeEditorHandle } from '../codeEditorTypes';
import { KeyboardShortcutProvider } from '@/keyboard/KeyboardShortcutProvider';
import { GlassRuntimeEnvironmentProvider } from '@/components/ui/glass/glassRuntimeEnvironment';


describe('MonacoEditorSurface (web)', () => {
    it('aligns its measured five-digit gutter with the shared code-view and review inset', async () => {
        setupMonacoGlobals();
        // Monaco sizes its number box in whole digits of the 13 px code font (7.8 px each here); the code view
        // draws 11 px numbers. The box is widened to cover the code view's number column and the slack padded.
        const digitWidth = 7.8;
        let minChars = 5;
        const updateOptions = vi.fn((options: { lineNumbersMinChars?: number }) => {
            if (options.lineNumbersMinChars !== undefined) minChars = options.lineNumbersMinChars;
        });
        const model = { ...createModelSpy.getMockImplementation()!(), getLineCount: () => 1 };
        const style = new Map<string, string>();
        // Monaco's public option boundary: font metrics and the current number-box width in digits.
        (globalThis as any).window.monaco.editor.EditorOption = { fontInfo: 'fontInfo', lineNumbersMinChars: 'lineNumbersMinChars' };
        const editorBoundary = { ...createEditorSpy.getMockImplementation()!(), updateOptions,
            getLayoutInfo: () => ({ lineNumbersWidth: Math.round(minChars * digitWidth), contentLeft: 69 }),
            getOption: (id: string) => id === 'fontInfo' ? { maxDigitWidth: digitWidth } : minChars,
            getDomNode: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }),
                style: { setProperty: (name: string, value: string) => { style.set(name, value); } } }),
        };
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce(editorBoundary);
        await renderScreen(<MonacoEditorSurface resetKey="gutter" value="one" language="text" onChange={vi.fn()} lineNumberDigits={5} reviewLaneWidth={32}
            contentPaddingHorizontal={16} />);
        expect(createEditorSpy.mock.calls[0]?.[1]).toMatchObject({ lineNumbersMinChars: 5, glyphMargin: false });
        // Code view: inset 16 + row 8 + review lane 32 + 4 + five 11 px digits (33) = digits end at 93, text at 111.
        expect(updateOptions).toHaveBeenCalledWith({ lineNumbersMinChars: 12 });
        expect(updateOptions).toHaveBeenLastCalledWith({ lineDecorationsWidth: 111 - Math.round(12 * digitWidth) });
        expect(style.get('--happier-line-number-slack')).toBe(`${Math.round(12 * digitWidth) - 93}px`);
    });
    it('captures Monaco goto chords and dispatches the app commands before built-in handlers', async () => {
        setupMonacoGlobals();
        const definition = vi.fn();
        const references = vi.fn();
        await renderScreen(<KeyboardShortcutProvider handlers={{ 'code.goToDefinition': definition, 'code.findReferences': references }}>
            <MonacoEditorSurface resetKey="intelligence-keys" value="const value = 1" language="typescript" onChange={vi.fn()} />
        </KeyboardShortcutProvider>);
        const capture = monacoDom.listeners.get('keydown');
        expect(capture).toEqual(expect.any(Function));
        for (const modifiers of [{}, { altKey: true }, { shiftKey: true }]) {
            const event = { key: 'F12', ...modifiers, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), isComposing: false };
            capture!(event as unknown as Event);
            expect(event.preventDefault).toHaveBeenCalledOnce();
            expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
        }
        expect(definition).toHaveBeenCalledTimes(2);
        expect(references).toHaveBeenCalledOnce();
    });
    it('reads the live selection, rounds its anchor range and releases selection subscriptions', async () => {
        setupMonacoGlobals();
        let selection = { startLineNumber: 1, startColumn: 3, endLineNumber: 3, endColumn: 1 };
        let changed: (() => void) | undefined;
        const text = 'first\nsecond\nthird';
        const model = {
            ...createModelSpy.getMockImplementation()!(),
            getValue: () => text,
            getLineContent: (line: number) => text.split('\n')[line - 1],
            getValueInRange: () => 'rst\nsecond\n',
        };
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce({
            ...createEditorSpy.getMockImplementation()!(),
            getSelection: () => selection,
            getScrolledVisiblePosition: () => ({ left: 20, top: 40, height: 18 }),
            getDomNode: () => ({ getBoundingClientRect: () => ({ left: 100, top: 200 }) }),
            onDidChangeCursorSelection: (listener: () => void) => { changed = listener; return { dispose: vi.fn() }; },
        });
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<MonacoEditorSurface ref={ref} resetKey="selection" value={text} language="text" onChange={vi.fn()} />);
        expect(ref.current?.getSelection?.()).toEqual({ startLine: 1, endLine: 2, text: 'rst\nsecond\n', rect: { x: 120, y: 240, width: 0, height: 18 } });
        const listener = vi.fn();
        const unsubscribe = ref.current!.subscribeSelection!(listener);
        selection = { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 };
        changed!();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(ref.current!.getSelection!()).toMatchObject({ startLine: 2, endLine: 2, text: 'second' });
        unsubscribe();
        listener.mockClear();
        changed!();
        expect(listener).not.toHaveBeenCalled();
    });
    it('disables every built-in TS and JS service before creating a model and delegates hover to the host', async () => {
        setupMonacoGlobals();
        await renderScreen(<MonacoEditorSurface resetKey="intelligence-order" value="const answer = 42" language="typescript" onChange={vi.fn()} />);
        const off = {
            completionItems: false, hovers: false, documentSymbols: false, definitions: false, references: false,
            documentHighlights: false, rename: false, diagnostics: false, documentRangeFormattingEdits: false,
            signatureHelp: false, onTypeFormattingEdits: false, codeActions: false, inlayHints: false,
        };
        expect(typescriptModeSpy).toHaveBeenCalledWith(off);
        expect(javascriptModeSpy).toHaveBeenCalledWith(off);
        expect(typescriptModeSpy.mock.invocationCallOrder[0]).toBeLessThan(createModelSpy.mock.invocationCallOrder[0]);
        expect(javascriptModeSpy.mock.invocationCallOrder[0]).toBeLessThan(createModelSpy.mock.invocationCallOrder[0]);
        expect(createModelSpy.mock.calls[0]).toEqual(['const answer = 42', 'typescript']);
        expect(createEditorSpy.mock.calls[0]?.[1]).toMatchObject({ hover: { enabled: false } });
    });
    it('publishes pointer and activation UTF-16 positions and releases subscribers', async () => {
        setupMonacoGlobals();
        let mouseMove: ((event: unknown) => void) | undefined;
        let mouseLeave: (() => void) | undefined;
        createEditorSpy.mockReturnValueOnce({
            ...createEditorSpy.getMockImplementation()!(),
            getPosition: () => ({ lineNumber: 2, column: 4 }),
            getTargetAtClientPoint: () => ({ position: { lineNumber: 2, column: 4 } }),
            getScrolledVisiblePosition: () => ({ left: 20, top: 30, height: 22 }),
            getDomNode: () => ({ getBoundingClientRect: () => ({ left: 100, top: 200 }) }),
            onMouseMove: (cb: (event: unknown) => void) => { mouseMove = cb; return { dispose: vi.fn() }; },
            onMouseLeave: (cb: () => void) => { mouseLeave = cb; return { dispose: vi.fn() }; },
        });
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<MonacoEditorSurface ref={ref} resetKey="intelligence-events" value="one\n😀 symbol" language="text" onChange={vi.fn()} />);
        const pointer = vi.fn();
        const activate = vi.fn();
        const stopPointer = ref.current!.onPointerPosition!(pointer);
        const stopActivate = ref.current!.onActivatePosition!(activate);
        expect(ref.current!.getCursorPosition!()).toEqual({ line: 2, character: 3 });
        mouseMove!({ target: { position: { lineNumber: 2, column: 4 } } });
        expect(pointer).toHaveBeenLastCalledWith({ line: 2, character: 3, rect: { x: 120, y: 230, width: 0, height: 22 } });
        const preventDefault = vi.fn();
        const stopImmediatePropagation = vi.fn();
        const mouseDown = monacoDom.listeners.get('mousedown')!;
        mouseDown({ clientX: 120, clientY: 230, metaKey: true, preventDefault, stopImmediatePropagation } as unknown as Event);
        expect(preventDefault).toHaveBeenCalled();
        expect(stopImmediatePropagation).toHaveBeenCalled();
        expect(activate).toHaveBeenLastCalledWith({ line: 2, character: 3 });
        mouseLeave!();
        expect(pointer).toHaveBeenLastCalledWith(null);
        stopPointer(); stopActivate();
        pointer.mockClear(); activate.mockClear();
        mouseMove!({ target: { position: { lineNumber: 2, column: 4 } } });
        mouseDown({ clientX: 120, clientY: 230, ctrlKey: true, preventDefault, stopImmediatePropagation } as unknown as Event);
        expect(pointer).not.toHaveBeenCalled();
        expect(activate).not.toHaveBeenCalled();
    });
    it('reveals a line, performs a minimal undoable replacement and ignores accessory commands during composition', async () => {
        setupMonacoGlobals();
        const text = 'first\nsecond\nlast';
        let compositionStart: (() => void) | undefined;
        let compositionEnd: (() => void) | undefined;
        const executeEdits = vi.fn();
        const trigger = vi.fn();
        const setPosition = vi.fn();
        const setSelection = vi.fn();
        const revealLineInCenter = vi.fn();
        const focus = vi.fn();
        const model = {
            getValue: () => text, setValue: vi.fn(), dispose: vi.fn(),
            getEOL: () => '\n',
            getLineCount: () => 3, getLineMaxColumn: () => 7,
            getPositionAt: (offset: number) => ({ lineNumber: offset < 6 ? 1 : offset < 13 ? 2 : 3, column: offset < 6 ? offset + 1 : offset < 13 ? offset - 5 : offset - 12 }),
            canUndo: () => false, canRedo: () => false,
        };
        createModelSpy.mockReturnValueOnce(model);
        createEditorSpy.mockReturnValueOnce({
            ...createEditorSpy.getMockImplementation()!(), executeEdits, trigger, setPosition, setSelection, revealLineInCenter, focus,
            pushUndoStop: vi.fn(),
            onDidCompositionStart: (cb: () => void) => { compositionStart = cb; return { dispose: vi.fn() }; },
            onDidCompositionEnd: (cb: () => void) => { compositionEnd = cb; return { dispose: vi.fn() }; },
        });
        const ref = React.createRef<CodeEditorHandle>();
        const onReady = vi.fn();
        await renderScreen(<MonacoEditorSurface ref={ref} resetKey="commands" value={text} language="text" onChange={vi.fn()} onReady={onReady} />);
        ref.current!.revealLine(2, { select: true, focus: true, behavior: 'instant' });
        expect(setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 1 });
        expect(setSelection).toHaveBeenCalledWith({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 7 });
        expect(revealLineInCenter).toHaveBeenCalledWith(2, 1);
        expect(focus).toHaveBeenCalled();
        expect(onReady).toHaveBeenCalled();
        ref.current!.runCommand({ replaceDocument: 'first\nSECOND\nlast' });
        expect(executeEdits).toHaveBeenCalledWith('happier.command', [{
            range: { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 7 }, text: 'SECOND', forceMoveMarkers: true,
        }]);
        const history = vi.fn();
        const unsubscribe = ref.current!.subscribeHistory(history);
        expect(history).toHaveBeenCalledWith({ canUndo: false, canRedo: false });
        ref.current!.runCommand('undo');
        expect(trigger).toHaveBeenLastCalledWith('happier.command', 'undo', null);
        compositionStart!();
        trigger.mockClear();
        ref.current!.runCommand('indent');
        expect(trigger).not.toHaveBeenCalled();
        compositionEnd!();
        ref.current!.runCommand('indent');
        expect(trigger).toHaveBeenLastCalledWith('happier.command', 'editor.action.indentLines', null);
        unsubscribe();
    });
    it('exposes the canonical decoration channel before the editor finishes booting', async () => {
        setupMonacoGlobals();
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(<MonacoEditorSurface ref={ref} resetKey="decoration" value="one" language="text" onChange={vi.fn()} />);
        expect(ref.current).toHaveProperty('setDecorations', expect.any(Function));
        expect(ref.current).toHaveProperty('onDecorationPress', expect.any(Function));
    });
    it('seeds the native find widget through the public action without changing the model', async () => {
        setupMonacoGlobals();
        const trigger = vi.fn();
        const setPosition = vi.fn();
        const revealPositionInCenter = vi.fn();
        const model = { getValue: () => 'first\r\nsecond\\n', setValue: vi.fn(), dispose: vi.fn() };
        createModelSpy.mockReturnValueOnce(model);
        const editorBoundary = {
            ...createEditorSpy.getMockImplementation()!(), trigger, setPosition, revealPositionInCenter,
        };
        createEditorSpy.mockReturnValueOnce(editorBoundary);
        const ref = React.createRef<CodeEditorHandle>();
        await renderScreen(React.createElement(MonacoEditorSurface, {
            ref, resetKey: 'seed', value: model.getValue(), language: 'plaintext', onChange: vi.fn(),
        }));
        ref.current?.find?.seed('\\n', { matchCase: true, regex: false }, { line: 2, column: 7 });
        expect(trigger).toHaveBeenCalledWith('happier.find', 'editor.actions.findWithArgs', {
            searchString: '\\n', isRegex: false, isCaseSensitive: true, matchWholeWord: false, findInSelection: false,
        });
        expect(setPosition).toHaveBeenCalledWith({ lineNumber: 2, column: 7 });
        expect(revealPositionInCenter).toHaveBeenCalledWith({ lineNumber: 2, column: 7 });
        expect(model.setValue).not.toHaveBeenCalled();
        expect(ref.current?.find?.presentation).toBe('native');
    });
    it('updates material paint without replacing the editor or dimming syntax', async () => {
        setupMonacoGlobals();
        const { storage } = await import('@/sync/domains/state/storage');
        const { glassPresetMaterials } = await import('@/components/ui/glass/glassMaterial');
        const previous = storage.getState().settings;
        const materials = glassPresetMaterials('everywhere');
        try {
            storage.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: materials } });
            await renderScreen(<GlassRuntimeEnvironmentProvider value={{ desktopWindow: true, nativeWindowMaterialLive: true }}>
                <MonacoEditorSurface resetKey="glass" value="const x = 1;" language="typescript" onChange={() => {}} />
            </GlassRuntimeEnvironmentProvider>);
            expect(defineThemeSpy).toHaveBeenLastCalledWith('happier-editor-dark', expect.objectContaining({
                colors: expect.objectContaining({ 'editor.background': '#1f1f1f00', 'editor.foreground': '#f8f8f2' }),
            }));
            await act(async () => {
                storage.setState({ settings: { ...previous, glassBlurEnabled: true, glassSurfaceMaterials: { ...materials, content: { blur: 'off', opacity: 1 } } } });
            });
            expect(createEditorSpy).toHaveBeenCalledTimes(1);
            expect(createModelSpy).toHaveBeenCalledTimes(1);
            expect(defineThemeSpy).toHaveBeenLastCalledWith('happier-editor-dark', expect.objectContaining({
                colors: expect.objectContaining({ 'editor.background': '#1f1f1f', 'editor.foreground': '#f8f8f2' }),
            }));
        } finally {
            await act(async () => { storage.setState({ settings: previous }); });
        }
    });
    it('boots Monaco even when initially not ready', async () => {
        setupMonacoGlobals();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange: vi.fn(),
                    wrapLines: true,
                    showLineNumbers: true,
                }));

        expect(createModelSpy).toHaveBeenCalledTimes(1);
        expect(createEditorSpy).toHaveBeenCalledTimes(1);
    });

    it('boots Monaco with a theme derived from app theme tokens', async () => {
        setupMonacoGlobals();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'const message = "hello";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }));

        expect(defineThemeSpy).toHaveBeenCalledWith(
            'happier-editor-dark',
            expect.objectContaining({
                base: 'vs-dark',
                inherit: true,
                colors: expect.objectContaining({
                    'editor.background': '#1f1f1f',
                    'editor.foreground': '#f8f8f2',
                    'editorLineNumber.foreground': '#8a8a8a',
                }),
                rules: expect.arrayContaining([
                    expect.objectContaining({ token: 'keyword', foreground: 'ff79c6' }),
                    expect.objectContaining({ token: 'string', foreground: '50fa7b' }),
                    expect.objectContaining({ token: 'comment', foreground: '6272a4' }),
                ]),
            }),
        );
        expect(setThemeSpy).toHaveBeenLastCalledWith('happier-editor-dark');
        expect(createEditorSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ theme: 'happier-editor-dark' }),
        );
    });

    it('updates the Monaco theme when the app theme changes after mount', async () => {
        setupMonacoGlobals();

        const result = await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'const message = "hello";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }));

        expect(setThemeSpy).toHaveBeenLastCalledWith('happier-editor-dark');

        unistylesState.currentTheme = lightEditorTheme;
        await act(async () => {
            await result.update(
                React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'const message = "hello";',
                    language: 'typescript',
                    onChange: vi.fn(),
                }),
            );
            await flushHookEffects();
        });

        expect(defineThemeSpy).toHaveBeenLastCalledWith(
            'happier-editor-light',
            expect.objectContaining({
                base: 'vs',
                colors: expect.objectContaining({
                    'editor.background': '#f6f8fa',
                    'editor.foreground': '#24292f',
                }),
            }),
        );
        expect(setThemeSpy).toHaveBeenLastCalledWith('happier-editor-light');
    });

    it('debounces onChange when changeDebounceMs is set', async () => {
        let currentValue = 'start';
        let changeHandler: null | ((..._args: any[]) => void) = null;
        let blurHandler: null | ((..._args: any[]) => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: (handler: (..._args: any[]) => void) => {
                        changeHandler = handler;
                        return { dispose: () => {} };
                    },
                    onDidBlurEditorText: (handler: (..._args: any[]) => void) => {
                        blurHandler = handler;
                        return { dispose: () => {} };
                    },
                    updateOptions: () => {},
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: currentValue,
                    language: 'markdown',
                    onChange,
                    changeDebounceMs: 50,
                }));

        const triggerChange = assertCallable(changeHandler, 'change handler');

        currentValue = 'a';
        triggerChange({});
        currentValue = 'ab';
        triggerChange({});
        currentValue = 'abc';
        triggerChange({});

        expect(onChange).toHaveBeenCalledTimes(0);

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 75));
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith('abc');
    });

    it('flushes pending debounced change on blur', async () => {
        let currentValue = 'start';
        let changeHandler: null | ((..._args: any[]) => void) = null;
        let blurHandler: null | ((..._args: any[]) => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: (handler: (..._args: any[]) => void) => {
                        changeHandler = handler;
                        return { dispose: () => {} };
                    },
                    onDidBlurEditorText: (handler: (..._args: any[]) => void) => {
                        blurHandler = handler;
                        return { dispose: () => {} };
                    },
                    updateOptions: () => {},
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: currentValue,
                    language: 'markdown',
                    onChange,
                    changeDebounceMs: 50,
                }));

        const triggerChange = assertCallable(changeHandler, 'change handler');
        const triggerBlur = assertCallable(blurHandler, 'blur handler');

        currentValue = 'blur-me';
        triggerChange({});

        expect(onChange).toHaveBeenCalledTimes(0);

        await act(async () => {
            triggerBlur({});
        });

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenLastCalledWith('blur-me');
    });

    it('keeps unflushed local edits when an external value arrives mid-typing (flushes instead of replacing the doc)', async () => {
        let currentValue = 'seed';
        let changeHandler: null | ((..._args: any[]) => void) = null;
        const setValueSpy = vi.fn((next: string) => {
            currentValue = next;
        });
        const executeEditsSpy = vi.fn((_source: string, edits: Array<{ text: string }>) => {
            currentValue = edits[0]?.text ?? currentValue;
        });

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: currentValue.length + 1 }),
                    setValue: setValueSpy,
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: (handler: (..._args: any[]) => void) => {
                        changeHandler = handler;
                        return { dispose: () => {} };
                    },
                    onDidBlurEditorText: () => ({ dispose: () => {} }),
                    updateOptions: () => {},
                    executeEdits: executeEditsSpy,
                    getSelections: () => null,
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(MonacoEditorSurface, {
            resetKey: '1',
            value: currentValue,
            language: 'markdown',
            onChange,
            changeDebounceMs: 100,
        }));

        const triggerChange = assertCallable(changeHandler, 'change handler');

        currentValue = 'local draft';
        triggerChange({});

        await act(async () => {
            await screen.update(React.createElement(MonacoEditorSurface, {
                resetKey: '1',
                value: 'external seed',
                language: 'markdown',
                onChange,
                changeDebounceMs: 100,
            }));
        });
        await flushHookEffects();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 125));
        });

        // The user's unflushed local edit is the source of truth: the stale/racing
        // external value must not replace the document (that resets the cursor and
        // loses keystrokes). The pending change is flushed upward so the parent
        // state converges to the editor instead.
        expect(executeEditsSpy).not.toHaveBeenCalled();
        expect(setValueSpy).not.toHaveBeenCalled();
        expect(currentValue).toBe('local draft');
        expect(onChange).toHaveBeenCalledWith('local draft');
    });

    it('exposes a stable imperative handle for flush/getValue', async () => {
        const ref = React.createRef<any>();

        let currentValue = 'hello';
        let blurHandler: null | (() => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: () => ({ dispose: () => {} }),
                    onDidBlurEditorText: (handler: () => void) => {
                        blurHandler = handler;
                        return { dispose: () => {} };
                    },
                    updateOptions: () => {},
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();

        await renderScreen(React.createElement(MonacoEditorSurface, {
                    ref,
                    resetKey: '1',
                    value: currentValue,
                    language: 'markdown',
                    onChange,
                    changeDebounceMs: 50,
                }));

        expect(ref.current).toBeTruthy();
        expect(typeof ref.current.getValue).toBe('function');
        expect(typeof ref.current.flushPendingChange).toBe('function');
        expect(ref.current.getValue()).toBe('hello');

        currentValue = 'world';
        expect(ref.current.getValue()).toBe('world');

        // Flush should be safe to call even if no timer is pending; blur handler should exist.
        await act(async () => {
            await ref.current.flushPendingChange();
        });
        expect(blurHandler).not.toBeNull();
    });

    it('applies external value changes through editor edits so selection and scroll position are preserved', async () => {
        let currentValue = 'first line\nsecond line';
        const setValueSpy = vi.fn((next: string) => {
            currentValue = next;
        });
        const executeEditsSpy = vi.fn((_source: string, edits: Array<{ text: string }>) => {
            currentValue = edits[0]?.text ?? currentValue;
        });
        const getSelectionsSpy = vi.fn(() => [{ startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 }]);
        const setSelectionsSpy = vi.fn();
        const getScrollTopSpy = vi.fn(() => 42);
        const getScrollLeftSpy = vi.fn(() => 7);
        const setScrollTopSpy = vi.fn();
        const setScrollLeftSpy = vi.fn();

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    getValue: () => currentValue,
                    getFullModelRange: () => ({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 12 }),
                    setValue: setValueSpy,
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: () => ({ dispose: () => {} }),
                    onDidBlurEditorText: () => ({ dispose: () => {} }),
                    updateOptions: () => {},
                    executeEdits: executeEditsSpy,
                    getSelections: getSelectionsSpy,
                    setSelections: setSelectionsSpy,
                    getScrollTop: getScrollTopSpy,
                    getScrollLeft: getScrollLeftSpy,
                    setScrollTop: setScrollTopSpy,
                    setScrollLeft: setScrollLeftSpy,
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(MonacoEditorSurface, {
            resetKey: '1',
            value: currentValue,
            language: 'markdown',
            onChange,
        }));

        await act(async () => {
            await screen.update(React.createElement(MonacoEditorSurface, {
                resetKey: '1',
                value: 'first line\nchanged second line',
                language: 'markdown',
                onChange,
            }));
            await flushHookEffects();
        });

        expect(executeEditsSpy).toHaveBeenCalledWith(
            'happier.external-value',
            [expect.objectContaining({ text: 'first line\nchanged second line' })],
            expect.anything(),
        );
        expect(setValueSpy).not.toHaveBeenCalled();
        expect(setSelectionsSpy).toHaveBeenCalledWith([{ startLineNumber: 2, startColumn: 4, endLineNumber: 2, endColumn: 4 }]);
        expect(setScrollTopSpy).toHaveBeenCalledWith(42);
        expect(setScrollLeftSpy).toHaveBeenCalledWith(7);
    });

    it('updates editor readOnly mode when the prop changes after mount', async () => {
        const updateOptionsSpy = vi.fn();

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        (globalThis as any).window.require = (deps: any, onOk?: any, _onErr?: any) => {
            if (typeof onOk === 'function') onOk();
        };
        (globalThis as any).window.monaco = {
            ...createMonacoLanguageServicesBoundary(),
            editor: {
                createModel: () => ({
                    getValue: () => 'hello',
                    setValue: () => {},
                    dispose: () => {},
                }),
                create: () => ({
                    onDidChangeModelContent: () => ({ dispose: () => {} }),
                    onDidBlurEditorText: () => ({ dispose: () => {} }),
                    updateOptions: updateOptionsSpy,
                    dispose: () => {},
                }),
            },
        };

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: true,
                }));

        updateOptionsSpy.mockClear();

        await act(async () => {
            await screen.update(
                React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }),
            );
            await flushHookEffects();
        });

        expect(updateOptionsSpy).toHaveBeenCalledWith(expect.objectContaining({ readOnly: false }));
    });

    it('boots Monaco with the latest readOnly mode when props change before Monaco resolves', async () => {
        const createEditorWithLatestOptionsSpy = vi.fn(() => ({
            onDidChangeModelContent: () => ({ dispose: () => {} }),
            onDidBlurEditorText: () => ({ dispose: () => {} }),
            updateOptions: () => {},
            dispose: () => {},
        }));

        let resolveEditorMain: null | (() => void) = null;

        (globalThis as any).window = (globalThis as any).window ?? {};
        (globalThis as any).document = (globalThis as any).document ?? {};

        delete (globalThis as any).window.monaco;
        (globalThis as any).window.require = Object.assign(
            (deps: any, onOk?: any, _onErr?: any) => {
                if (Array.isArray(deps) && deps[0] === 'vs/editor/editor.main') {
                    resolveEditorMain = () => {
                        (globalThis as any).window.monaco = {
                            ...createMonacoLanguageServicesBoundary(),
                            editor: {
                                createModel: () => ({
                                    getValue: () => 'hello',
                                    setValue: () => {},
                                    dispose: () => {},
                                }),
                                create: createEditorWithLatestOptionsSpy,
                            },
                        };
                        if (typeof onOk === 'function') onOk();
                    };
                    return;
                }
                if (typeof onOk === 'function') onOk();
            },
            { config: vi.fn() },
        );

        const onChange = vi.fn();
        const screen = await renderScreen(React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: true,
                }));

        await act(async () => {
            await screen.update(
                React.createElement(MonacoEditorSurface, {
                    resetKey: '1',
                    value: 'hello',
                    language: 'markdown',
                    onChange,
                    readOnly: false,
                }),
            );
            await flushHookEffects();
        });

        expect(createEditorWithLatestOptionsSpy).not.toHaveBeenCalled();

        await act(async () => {
            if (!resolveEditorMain) throw new Error('expected editor main loader callback');
            resolveEditorMain();
            await flushHookEffects();
        });

        expect(createEditorWithLatestOptionsSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ readOnly: false }),
        );
    });
});
