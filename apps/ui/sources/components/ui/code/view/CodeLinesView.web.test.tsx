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
    it.each([500, 5_000])('lands a revealed target when its row is measured after %i ms', async (mountDelay) => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: 'before\nfolded match\nafter' });
        const target = lines[1]!;
        vi.useFakeTimers();
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} virtualized={false} scrollToLineId={target.id} />);
        const row = screen.tree.root.findAll(node => typeof node.type === 'string' && node.props.nativeID?.endsWith(`-${target.id}`))[0]!;
        const element = document.createElement('div');
        element.id = row.props.nativeID;
        // Browser layout and the React Native Web layout event are the only substituted boundaries.
        const scrollIntoView = vi.fn();
        element.scrollIntoView = scrollIntoView;
        try {
            await renderer.act(async () => { vi.advanceTimersByTime(mountDelay); });
            expect(scrollIntoView).not.toHaveBeenCalled();
            document.body.append(element);
            await renderer.act(async () => { row.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 1200, width: 400, height: 22 } } }); });
            expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'center' });
            scrollIntoView.mockClear();
            await screen.update(<CodeLinesViewCore lines={[...lines]} virtualized={false} scrollToLineId={target.id} />);
            await renderer.act(async () => { row.props.onLayout?.({ nativeEvent: { layout: { x: 0, y: 1200, width: 400, height: 22 } } }); });
            expect(scrollIntoView).not.toHaveBeenCalled();
        } finally {
            await screen.unmount();
            element.remove();
            vi.useRealTimers();
        }
    });

    it('washes the block the agent writes and stands its caret after the block\'s last line (P5 Track)', async () => {
        const { CodeLinesViewCore } = await import('./CodeLinesViewCore');
        const { EditorAgentCaret } = await import('@/components/ui/motion/EditorAgentCaret');
        const { buildCodeLinesFromFile } = await import('../model/buildCodeLinesFromFile');
        const lines = buildCodeLinesFromFile({ text: Array.from({ length: 6 }, (_, index) => `line ${index + 1}`).join('\n') });
        const presence = { startLine: 3, endLine: 4, agentId: null, agentName: 'Claude', reducedMotion: false };
        const screen = await renderScreen(<CodeLinesViewCore lines={lines} agentPresence={presence} />);
        const rows = await findCodeRows(screen.tree);
        expect(rows.filter(row => row.props.agentWash).map(row => row.props.line.newLine)).toEqual([3, 4]);
        expect(rows.filter(row => row.props.agentCaret).map(row => row.props.line.newLine)).toEqual([4]);
        expect(screen.tree.root.findAllByType(EditorAgentCaret)).toHaveLength(1);

        // The next region: the caret leaves line 4 and arrives after line 6, travelling from where it stood.
        await screen.update(<CodeLinesViewCore lines={lines} agentPresence={{ ...presence, startLine: 6, endLine: 6 }} />);
        const moved = await findCodeRows(screen.tree);
        expect(moved.filter(row => row.props.agentCaret).map(row => row.props.line.newLine)).toEqual([6]);
        expect(screen.tree.root.findByType(EditorAgentCaret).props.travelFromPx).toBeLessThan(0);
        await screen.update(<CodeLinesViewCore lines={lines} agentPresence={null} />);
        expect(screen.tree.root.findAllByType(EditorAgentCaret)).toHaveLength(0);
    });

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
            // Activation is covered through the real row press in CodeLinesView.touch.web.test.
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
