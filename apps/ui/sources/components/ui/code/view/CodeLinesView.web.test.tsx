// @vitest-environment jsdom
import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installCodeViewCommonModuleMocks } from './codeViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installCodeViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Platform: {
                OS: 'web',
                select: (options: any) => options?.web ?? options?.default ?? options?.ios ?? options?.android,
            },
            FlatList: (props: any) => {
                const items = Array.isArray(props.data)
                    ? props.data.map((item: any, index: number) =>
                        React.createElement(
                            React.Fragment,
                            { key: props.keyExtractor ? props.keyExtractor(item) : String(index) },
                            props.renderItem ? props.renderItem({ item, index }) : null,
                        )
                    )
                    : null;
                return React.createElement('FlatList', props, items);
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                dark: false,
                colors: {
                    surface: { base: '#fff', inset: '#fff' },
                    text: { primary: '#111', secondary: '#666' },
                    syntax: {
                        default: '#111',
                        keyword: '#123456',
                        string: '#0a3069',
                        comment: '#666',
                        number: '#0550ae',
                        function: '#8250df',
                    },
                },
            },
        });
    },
});

async function findCodeRows(tree: renderer.ReactTestRenderer) {
    const { CodeLineRow } = await import('./CodeLineRow');
    return tree.root.findAllByType(CodeLineRow);
}

const createHighlighterSpy = vi.fn(async (..._args: any[]) => ({
    loadLanguage: async () => {},
    codeToTokens: () => ({
        fg: '#000',
        tokens: [[{ content: 'const', color: '#f00' }]],
    }),
}));

vi.mock('shiki', () => ({
    bundledLanguages: {
        ts: {},
        js: {},
        python: {},
    },
    createHighlighter: (...args: any[]) => createHighlighterSpy(...args),
}));

async function flushReactAsyncWork(): Promise<void> {
    // The highlighter and its regex engine load through dynamic imports; microtask
    // flushing alone does not wait for Vite to finish those module requests.
    await vi.dynamicImportSettled();
    await flushHookEffects({ cycles: 10, turns: 25 });
}

describe('CodeLinesView (web)', () => {
    it('opens a web list at a later line from the top, so rows before that line are not left as an unrendered gap', async () => {
        // React Native Web's list rendered only the window after `initialScrollIndex` and never filled the rows
        // above it when the content did not scroll (File page Changes opening at its first change). The scroll
        // effect lands the line instead.
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n') });
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} virtualized scrollToLineId={lines[12]!.id} />);

        const list = screen.tree.root.findAll((node) => (node.type as unknown) === 'FlatList')[0]!;
        expect(list.props.initialScrollIndex).toBeUndefined();
    });

    it('delegates nested token pointer offsets in UTF-16 and never activates removed diff lines', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: '😀 target' });
        const pointer = vi.fn();
        const activate = vi.fn();
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} intelligence={{ onPointerToken: pointer, onActivateToken: activate }} />);
        const row = document.createElement('div');
        row.id = screen.tree.root.findAll(node => typeof node.props.nativeID === 'string' && node.props.nativeID.endsWith(`-${lines[0].id}`))[0].props.nativeID;
        const code = document.createElement('span');
        code.setAttribute('data-code-text', lines[0].id);
        code.innerHTML = '<span>😀 </span><span>target</span>';
        row.append(code);
        document.body.append(row);
        const target = code.lastElementChild!;
        // Only caret hit testing and geometry substitute browser layout; DOM spans/ranges stay real.
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: target.firstChild, offset: 2 }) });
        const geometry = vi.spyOn(code, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 10, 200, 20));
        try {
            const list = screen.tree.root.findByType('FlatList');
            expect(list.props.onPointerMove).toEqual(expect.any(Function));
            list.props.onPointerMove({ target, clientX: 10, clientY: 20 });
            expect(pointer).toHaveBeenLastCalledWith(lines[0].id, 5, { x: 10, y: 10, width: 1, height: 20 }, 1);
            // Rows stop bubbling clicks; the genuine document capture listener still sees them.
            target.addEventListener('click', event => event.stopPropagation());
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20, metaKey: true }));
            expect(activate).toHaveBeenLastCalledWith(lines[0].id, 5, { via: 'modifier', rect: { x: 10, y: 10, width: 1, height: 20 } }, 1);
            pointer.mockClear(); activate.mockClear();
            await screen.update(<CodeLinesViewCore lines={[{ ...lines[0], kind: 'remove', newLine: null }]} intelligence={{ onPointerToken: pointer, onActivateToken: activate }} />);
            const updated = screen.tree.root.findByType('FlatList');
            updated.props.onPointerMove({ target, clientX: 10, clientY: 20 });
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 20, ctrlKey: true }));
            expect(pointer).not.toHaveBeenCalled();
            expect(activate).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            row.remove();
            geometry.mockRestore();
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });
    it('names the tapped token on touch where line ranges are selectable, and keeps a tap off the code selecting the line', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: 'const target = 1;' });
        const activate = vi.fn();
        const onPressLine = vi.fn();
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} interactionMode="commitSelection"
            onPressLine={onPressLine} onPressLineRange={vi.fn()} intelligence={{ onPointerToken: vi.fn(), onActivateToken: activate }} />);
        const row = document.createElement('div');
        row.id = screen.tree.root.findAll(node => typeof node.props.nativeID === 'string' && node.props.nativeID.endsWith(`-${lines[0].id}`))[0].props.nativeID;
        const code = document.createElement('span');
        code.setAttribute('data-code-text', lines[0].id);
        code.textContent = 'const target = 1;';
        row.append(code);
        document.body.append(row);
        const previousCaret = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint');
        Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: code.firstChild, offset: 8 }) });
        const geometry = vi.spyOn(code, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 10, 200, 20));
        const touchUp = (target: EventTarget) => {
            const event = new MouseEvent('pointerup', { bubbles: true, clientX: 60, clientY: 20 });
            Object.defineProperty(event, 'pointerType', { value: 'touch' });
            target.dispatchEvent(event);
        };
        try {
            const rows = await findCodeRows(screen.tree);
            touchUp(code);
            expect(activate).toHaveBeenLastCalledWith(lines[0].id, 8, expect.objectContaining({ via: 'touch' }), 1);
            // The same tap's row press belongs to the name, not to a one-line selection.
            rows[0]!.props.onPressLine(lines[0], {});
            expect(onPressLine).not.toHaveBeenCalled();
            // A tap that names nothing still selects the line.
            Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => null });
            touchUp(row);
            rows[0]!.props.onPressLine(lines[0], {});
            expect(onPressLine).toHaveBeenCalledTimes(1);
        } finally {
            await screen.unmount();
            row.remove();
            geometry.mockRestore();
            if (previousCaret) Object.defineProperty(document, 'caretPositionFromPoint', previousCaret);
            else Reflect.deleteProperty(document, 'caretPositionFromPoint');
        }
    });

    it('completes a web drag range in an explicit interaction mode', async () => {
        const { CodeLinesView } = await import('./CodeLinesView.web');

        const onPressLineRange = vi.fn();
        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'one',
                renderIsHeaderLine: false,
                selectable: true,
            },
            {
                id: 'f:2',
                sourceIndex: 1, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 2,
                renderPrefixText: '',
                renderCodeText: 'two',
                renderIsHeaderLine: false,
                selectable: true,
            },
            {
                id: 'f:3',
                sourceIndex: 2, hunkIndex: null,
                kind: 'file' as const,
                oldLine: null,
                newLine: 3,
                renderPrefixText: '',
                renderCodeText: 'three',
                renderIsHeaderLine: false,
                selectable: true,
            },
        ];

        const screen = await renderScreen(<CodeLinesView
            virtualized={false}
            interactionMode="commitSelection"
            lines={lines}
            onPressLineRange={onPressLineRange}
        />);

        const rows = await findCodeRows(screen.tree);
        const event = { preventDefault: vi.fn(), nativeEvent: { preventDefault: vi.fn() } };
        const onPressInLine = rows[0]!.props.onPressInLine;
        const onHoverLine = rows[2]!.props.onHoverLine;
        const onPressOutLine = rows[2]!.props.onPressOutLine;
        if (!onPressInLine || !onHoverLine || !onPressOutLine) throw new Error('Expected web drag-range interaction callbacks');
        onPressInLine(lines[0], event);
        onHoverLine(lines[2], event);
        onPressOutLine(lines[2], event);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.nativeEvent.preventDefault).toHaveBeenCalled();
        expect(onPressLineRange).toHaveBeenCalledTimes(1);
        expect(onPressLineRange.mock.calls[0]?.[0].map((line: any) => line.id)).toEqual(['f:1', 'f:2', 'f:3']);
    });

    it('retries highlighter initialization after a cached failure', async () => {
        createHighlighterSpy.mockReset();
        createHighlighterSpy
            .mockImplementationOnce(async () => {
                throw new Error('shiki_init_failed');
            })
            .mockImplementation(async () => ({
                loadLanguage: async () => {},
                codeToTokens: () => ({
                    fg: '#000',
                    tokens: [[{ content: 'const', color: '#f00' }]],
                }),
            }));

        const { CodeLinesView } = await import('./CodeLinesView.web');

        const view = (
            <CodeLinesView
                lines={[
                    {
                        id: 'f:1',
                        sourceIndex: 0, hunkIndex: null,
                        kind: 'file',
                        oldLine: null,
                        newLine: 1,
                        renderPrefixText: '',
                        renderCodeText: 'const x = 1;',
                        renderIsHeaderLine: false,
                        selectable: false,
                    },
                ]}
                syntaxHighlighting={{
                    mode: 'advanced',
                    language: 'typescript',
                    maxBytes: 1_000_000,
                    maxLines: 10_000,
                    maxLineLength: 10_000,
                }}
            />
        );

        const screen1 = await renderScreen(view);
        await flushReactAsyncWork();

        // Uses Happier themes instead of generic GitHub themes.
        expect(createHighlighterSpy.mock.calls[0]?.[0]?.themes?.[0]?.name).toMatch(/^happier-light-/);

        const calls1 = (await findCodeRows(screen1.tree)).map((row) => row.props);
        expect(calls1.some((p: any) => Array.isArray(p.advancedTokens) && p.advancedTokens.length > 0)).toBe(false);

        renderer.act(() => {
            screen1.tree.unmount();
        });

        const screen2 = await renderScreen(view);
        await flushReactAsyncWork();

        const calls2 = (await findCodeRows(screen2.tree)).map((row) => row.props);
        expect(calls2.some((p: any) => Array.isArray(p.advancedTokens) && p.advancedTokens.length > 0)).toBe(true);
        expect(createHighlighterSpy).toHaveBeenCalledTimes(2);

        expect(await findCodeRows(screen2.tree)).toHaveLength(1);
    });

    it('computes Shiki tokens when advanced syntax highlighting is enabled', async () => {
        createHighlighterSpy.mockClear();
        const { CodeLinesView } = await import('./CodeLinesView.web');

        const screen = await renderScreen(<CodeLinesView
                    lines={[
                        {
                            id: 'f:1',
                            sourceIndex: 0, hunkIndex: null,
                            kind: 'file',
                            oldLine: null,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'const x = 1;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                    syntaxHighlighting={{
                        mode: 'advanced',
                        language: 'typescript',
                        maxBytes: 1_000_000,
                        maxLines: 10_000,
                        maxLineLength: 10_000,
                    }}
                />);

        // The row will be rendered at least once; after async tokenization, it should receive advancedTokens.
        let hasAdvanced = false;
        for (let i = 0; i < 10; i++) {
            // eslint-disable-next-line no-await-in-loop
            await flushReactAsyncWork();
            const calls = (await findCodeRows(screen.tree)).map((row) => row.props);
            if (calls.length === 0) continue;
            hasAdvanced = calls.some((p: any) => Array.isArray(p.advancedTokens) && p.advancedTokens.length > 0);
            if (hasAdvanced) break;
        }
        expect(hasAdvanced).toBe(true);

        // Keep tree referenced to avoid act warnings about unmounted trees.
        expect(await findCodeRows(screen.tree)).toHaveLength(1);
    });
});
