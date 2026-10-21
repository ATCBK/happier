import { act } from 'react-test-renderer';
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import type { AutocompleteSuggestion, AutocompleteSuggestionUpdate } from '@/components/autocomplete/autocompleteTypes';
import { useActiveSuggestions, type ActiveSuggestionsHandler } from '@/components/autocomplete/useActiveSuggestions';

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
import { useAgentInputCommandMenu } from '../useAgentInputCommandMenu';

type HookArgs = Parameters<typeof useAgentInputCommandMenu>[0];

function buildDefaultArgs(overrides: Partial<HookArgs> = {}): HookArgs {
    return {
        suggestions: [
            { kind: 'slashCommand', key: 'cmd-goal', text: '/goal', label: 'goal', description: 'Set a goal', rowHeight: 52 },
            { kind: 'slashCommand', key: 'cmd-help', text: '/help', label: 'help', description: 'Show help' },
        ],
        selected: 0,
        activeWord: '/g',
        activeWordRange: { start: 0, end: 2 },
        inputTextLength: 2,
        moveUp: vi.fn(),
        moveDown: vi.fn(),
        selectionForKind: () => ({ selected: overrides.selected ?? 0, selectionPending: overrides.selectionPending ?? false }),
        handleSuggestionSelect: vi.fn(),
        ...overrides,
    };
}

describe('useAgentInputCommandMenu', () => {
    it('wraps through the picker in either direction without skipping the first command', async () => {
        const hook = await renderHook(() => {
            const [selected, setSelected] = React.useState(0);
            return useAgentInputCommandMenu(buildDefaultArgs({ selected, onOpenPromptPicker: vi.fn(),
                moveDown: () => setSelected((value) => (value + 1) % 2),
                moveUp: () => setSelected((value) => (value + 1) % 2),
            }));
        });
        await act(async () => hook.getCurrent().moveUp());
        expect(hook.getCurrent().selectedIndex).toBe(2);
        await act(async () => hook.getCurrent().moveDown());
        expect(hook.getCurrent().selectedIndex).toBe(0);
        await act(async () => hook.getCurrent().moveDown());
        expect(hook.getCurrent().selectedIndex).toBe(1);
        await act(async () => hook.getCurrent().moveDown());
        expect(hook.getCurrent().selectedIndex).toBe(2);
        await act(async () => hook.getCurrent().moveUp());
        expect(hook.getCurrent().selectedIndex).toBe(1);
    });
    it('opens the picker from the last slash row and keyboard navigation can reach it', async () => {
        const onOpenPromptPicker = vi.fn();
        const hook = await renderHook(() => useAgentInputCommandMenu(buildDefaultArgs({ selected: 1, onOpenPromptPicker })));
        expect(hook.getCurrent().items.at(-1)?.id).toBe('prompt-picker');
        await act(async () => hook.getCurrent().moveDown());
        expect(hook.getCurrent().selectedIndex).toBe(2);
        await act(async () => hook.getCurrent().onSelectFromMenu());
        expect(onOpenPromptPicker).toHaveBeenCalledOnce();
    });
    it('opens only when suggestions and an active trigger are present', async () => {
        const { getCurrent, rerender } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs() },
        );

        expect(getCurrent().commandMenuOpen).toBe(true);

        await rerender(buildDefaultArgs({ suggestions: [] }));
        expect(getCurrent().commandMenuOpen).toBe(false);

        await rerender(buildDefaultArgs({ activeWord: null }));
        expect(getCurrent().commandMenuOpen).toBe(false);
    });

    it('selects the current suggestion and falls back to the first item', async () => {
        const handleSuggestionSelect = vi.fn();
        const { getCurrent, rerender } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: buildDefaultArgs({ selected: 1, handleSuggestionSelect }) },
        );

        getCurrent().onSelectFromMenu();
        expect(handleSuggestionSelect).toHaveBeenCalledWith(1);

        await rerender(buildDefaultArgs({ selected: -1, handleSuggestionSelect }));
        getCurrent().onSelectFromMenu();
        expect(handleSuggestionSelect).toHaveBeenLastCalledWith(0);
    });

    it('does not fall back to the first row while a pinned candidate awaits a current partial update', async () => {
        const handleSuggestionSelect = vi.fn();
        const pendingSelectionArgs = buildDefaultArgs({
            selected: -1,
            selectionPending: true,
            handleSuggestionSelect,
        });
        const { getCurrent } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: pendingSelectionArgs },
        );

        getCurrent().onSelectFromMenu();

        expect(handleSuggestionSelect).not.toHaveBeenCalled();
    });

    it('suppresses a dismissed trigger until the active trigger changes', async () => {
        const firstTrigger = buildDefaultArgs({
            activeWord: '/foo',
            activeWordRange: { start: 0, end: 4 },
            inputTextLength: 24,
        });
        const { getCurrent, rerender } = await renderHook(
            (props: HookArgs) => useAgentInputCommandMenu(props),
            { initialProps: firstTrigger },
        );

        expect(getCurrent().commandMenuOpen).toBe(true);

        await act(async () => {
            getCurrent().onCloseMenu();
        });
        await rerender(firstTrigger);
        expect(getCurrent().commandMenuOpen).toBe(false);

        await rerender(buildDefaultArgs({
            activeWord: '/foo',
            activeWordRange: { start: 10, end: 14 },
            inputTextLength: 24,
        }));
        expect(getCurrent().commandMenuOpen).toBe(true);
    });

    describe('reference picker', () => {
        const references = [
            { kind: 'file' as const, key: 'f1', text: '@a.ts', label: 'a.ts' },
            { kind: 'session' as const, key: 's1', text: '@s1', label: 'Relay retry' },
            { kind: 'file' as const, key: 'f2', text: '@b.ts', label: 'b.ts' },
        ];
        const referenceArgs = (overrides: Partial<HookArgs> = {}): HookArgs => buildDefaultArgs({
            suggestions: references, selected: 0, activeWord: '@', activeWordRange: { start: 4, end: 5 }, inputTextLength: 5,
            kindTabs: ['file', 'session'], settledEmpty: true, emptyStateWhenResolved: true, ...overrides,
        });

        it('cycles the kind tabs and shows only that kind, keeping each row selectable by its own index', async () => {
            const handleSuggestionSelect = vi.fn();
            const handler: ActiveSuggestionsHandler = async () => references;
            const hook = await renderHook(() => {
                const [suggestions, selected, moveUp, moveDown, selectionPending, settledEmpty, selectionForKind] = useActiveSuggestions('@', handler);
                return useAgentInputCommandMenu(referenceArgs({ suggestions, selected, moveUp, moveDown, selectionPending, settledEmpty, selectionForKind, handleSuggestionSelect }));
            });
            await flushHookEffects();
            expect(hook.getCurrent().kindTab).toBeNull();
            expect(hook.getCurrent().items.map((item) => item.id)).toHaveLength(3);
            await act(async () => hook.getCurrent().cycleKindTab?.());
            expect(hook.getCurrent().kindTab).toBe('file');
            expect(hook.getCurrent().items.map((item) => item.label)).toEqual(['a.ts', 'b.ts']);
            await act(async () => hook.getCurrent().moveDown());
            expect(hook.getCurrent().selectedIndex).toBe(1);
            await act(async () => hook.getCurrent().onSelectFromMenu());
            // b.ts is the third suggestion of the whole list.
            expect(handleSuggestionSelect).toHaveBeenCalledWith(2);
            await act(async () => hook.getCurrent().cycleKindTab?.());
            expect(hook.getCurrent().kindTab).toBe('session');
            await act(async () => hook.getCurrent().cycleKindTab?.());
            expect(hook.getCurrent().kindTab).toBeNull();
        });

        it('keeps a kind-tab choice pinned through delayed rows and query refinement, pending while absent', async () => {
            const first = createDeferred<AutocompleteSuggestion[]>();
            const refined = createDeferred<AutocompleteSuggestion[]>();
            const publications = new Map<string, AutocompleteSuggestionUpdate>();
            const handler: ActiveSuggestionsHandler = (query, signal, publish) => {
                publications.set(query, publish);
                if (query === '@') {
                    signal.addEventListener('abort', () => first.resolve([]), { once: true });
                    return first.promise;
                }
                return refined.promise;
            };
            const selectedKeys: string[] = [];
            const hook = await renderHook(({ query }: { query: string }) => {
                const [suggestions, selected, moveUp, moveDown, selectionPending, settledEmpty, selectionForKind] = useActiveSuggestions(query, handler);
                return useAgentInputCommandMenu(referenceArgs({
                    suggestions, selected, moveUp, moveDown, selectionPending, settledEmpty, selectionForKind,
                    activeWord: query, activeWordRange: { start: 4, end: 4 + query.length },
                    handleSuggestionSelect: (index) => selectedKeys.push(suggestions[index]!.key),
                }));
            }, { initialProps: { query: '@' } });
            await flushHookEffects();
            await act(async () => publications.get('@')!([...references]));
            await act(async () => hook.getCurrent().setKindTab('file'));
            await act(async () => hook.getCurrent().moveDown());
            expect(hook.getCurrent().items[hook.getCurrent().selectedIndex]?.label).toBe('b.ts');

            const added: AutocompleteSuggestion = { kind: 'file', key: 'new', text: '@new.ts', label: 'new.ts' };
            await act(async () => publications.get('@')!([added, ...references]));
            expect(hook.getCurrent().items[hook.getCurrent().selectedIndex]?.label).toBe('b.ts');
            await act(async () => hook.getCurrent().onSelectFromMenu());
            expect(selectedKeys).toEqual(['f2']);

            await hook.rerender({ query: '@b' });
            await flushHookEffects();
            await act(async () => publications.get('@b')!([references[0]!]));
            expect(hook.getCurrent().kindTab).toBe('file');
            expect(hook.getCurrent().commandMenuOpen).toBe(true);
            expect(hook.getCurrent().selectedIndex).toBe(-1);
            await act(async () => hook.getCurrent().onSelectFromMenu());
            expect(selectedKeys).toEqual(['f2']);

            refined.resolve([references[0]!, references[2]!]);
            await flushHookEffects();
            expect(hook.getCurrent().items[hook.getCurrent().selectedIndex]?.label).toBe('b.ts');
            await act(async () => hook.getCurrent().onSelectFromMenu());
            expect(selectedKeys).toEqual(['f2', 'f2']);
        });

        it('uses enabled candidates for automatic kind selection and navigation', async () => {
            const rows: AutocompleteSuggestion[] = [
                references[1]!,
                { ...references[0]!, key: 'disabled-first', disabled: true },
                references[0]!,
                { ...references[0]!, key: 'disabled-middle', disabled: true },
                references[2]!,
            ];
            const handler: ActiveSuggestionsHandler = async () => rows;
            const handleSuggestionSelect = vi.fn();
            const hook = await renderHook(() => {
                const [suggestions, selected, moveUp, moveDown, selectionPending, settledEmpty, selectionForKind] = useActiveSuggestions('@', handler);
                return useAgentInputCommandMenu(referenceArgs({ suggestions, selected, moveUp, moveDown, selectionPending, settledEmpty, selectionForKind, handleSuggestionSelect }));
            });
            await flushHookEffects();
            await act(async () => hook.getCurrent().setKindTab('file'));
            expect(hook.getCurrent().selectedIndex).toBe(1);
            await act(async () => hook.getCurrent().moveDown());
            expect(hook.getCurrent().selectedIndex).toBe(3);
            await act(async () => hook.getCurrent().onSelectFromMenu());
            expect(handleSuggestionSelect).toHaveBeenLastCalledWith(4);
            await act(async () => hook.getCurrent().moveUp());
            expect(hook.getCurrent().selectedIndex).toBe(1);
            await act(async () => hook.getCurrent().onSelectFromMenu());
            expect(handleSuggestionSelect).toHaveBeenLastCalledWith(2);
        });

        it('stays open on a settled empty answer to show its empty state, and holds no keys but Escape', async () => {
            const hook = await renderHook((props: HookArgs) => useAgentInputCommandMenu(props), {
                initialProps: referenceArgs({ suggestions: [], settledEmpty: false, activeWord: '@zebra', activeWordRange: { start: 4, end: 10 } }),
            });
            // Still looking: the frame stays, without claiming there is nothing.
            expect(hook.getCurrent().commandMenuOpen).toBe(true);
            expect(hook.getCurrent().showsEmptyState).toBe(false);
            await hook.rerender(referenceArgs({ suggestions: [], settledEmpty: true, activeWord: '@zebra', activeWordRange: { start: 4, end: 10 } }));
            expect(hook.getCurrent().commandMenuOpen).toBe(true);
            expect(hook.getCurrent().showsEmptyState).toBe(true);
            expect(hook.getCurrent().selectable).toBe(false);
            // A slash command list keeps today's rule: no rows, no menu.
            await hook.rerender(buildDefaultArgs({ suggestions: [], settledEmpty: true }));
            expect(hook.getCurrent().commandMenuOpen).toBe(false);
        });

        it('starts a new trigger on All', async () => {
            const hook = await renderHook((props: HookArgs) => useAgentInputCommandMenu(props), { initialProps: referenceArgs() });
            await act(async () => hook.getCurrent().cycleKindTab?.());
            expect(hook.getCurrent().kindTab).toBe('file');
            await hook.rerender(referenceArgs({ activeWordRange: { start: 12, end: 13 }, inputTextLength: 13 }));
            expect(hook.getCurrent().kindTab).toBeNull();
        });
    });
});

