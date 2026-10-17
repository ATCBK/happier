import * as React from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import type {
    SelectionListDynamicSection,
    SelectionListProps,
    SelectionListStep,
} from '../_types';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            OS: 'android',
            select: <T,>(values: { android?: T; default?: T; web?: T }) =>
                values.android ?? values.default ?? values.web,
        },
    });
});

function makeStep(section: SelectionListDynamicSection): SelectionListStep {
    return {
        id: 'root',
        inputPlaceholder: 'Search',
        sections: [{ kind: 'dynamic', ...section }],
    };
}

function defaultProps(rootStep: SelectionListStep, overrides: Partial<SelectionListProps> = {}): SelectionListProps {
    return {
        rootStep,
        onSelect: vi.fn(),
        onRequestClose: vi.fn(),
        keyboardHintsEnabled: false,
        disableTransitions: true,
        testID: 'sl',
        ...overrides,
    };
}

function makeKeyEvent(key: string): Readonly<{
    key: string;
    preventDefault: () => void;
    stopPropagation: () => void;
}> {
    return {
        key,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    };
}

function statusText(screen: { findByTestId: (id: string) => { props: Record<string, any> } | null }): unknown {
    return screen.findByTestId('sl:status')?.props.children?.props.children;
}

function statusEventKey(screen: { findByTestId: (id: string) => { props: Record<string, any> } | null }): unknown {
    return screen.findByTestId('sl:status')?.props.children?.key;
}

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('SelectionList dynamic-section state rendering (Phase 2.2 mapping)', () => {
    it('projects one polite bounded provider status from loading through result settlement', async () => {
        const { act } = await import('react-test-renderer');
        let settle: ((value: { options: Array<{ id: string; label: string }> }) => void) | undefined;
        const root = makeStep({
            id: 'dyn',
            title: 'MESSAGES',
            debounceMs: 0,
            resultFiltering: 'provider',
            resolve: () => new Promise((resolve) => { settle = resolve; }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="query" />);

        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        const loadingStatus = screen.findByTestId('sl:status');
        expect(loadingStatus?.props.role).toBe('status');
        expect(loadingStatus?.props['aria-live']).toBe('polite');
        expect(loadingStatus?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.getTextContent()).toContain('MESSAGES · Loading…');

        await act(async () => {
            settle?.({
                options: [
                    { id: 'message:one', label: 'One' },
                    { id: 'message:two', label: 'Two' },
                ],
            });
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.getTextContent()).toContain('2 · MESSAGES');
        expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(1);
    });

    it('announces the displayed result count after canonical host filtering', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'SESSIONS',
            debounceMs: 0,
            resolve: async () => ({
                options: [
                    { id: 'one', label: 'Needle one' },
                    { id: 'two', label: 'Unrelated' },
                    { id: 'three', label: 'Needle three' },
                ],
            }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root)} inputValue="needle" />,
        );

        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(statusText(screen)).toContain('2 · SESSIONS');
        expect(statusText(screen)).not.toContain('3 · SESSIONS');
    });

    it('publishes a new live-region event when a distinct settled query has the same announcement text', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'SESSIONS',
            debounceMs: 0,
            resultFiltering: 'provider',
            resolve: async (query) => ({
                options: [{ id: `result:${query}`, label: `Result for ${query}` }],
            }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(
            <SelectionList {...defaultProps(root)} inputValue="first" />,
        );

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        const firstStatus = screen.findByTestId('sl:status');
        const firstEventKey = statusEventKey(screen);
        expect(statusText(screen)).toBe('1 · SESSIONS');

        await screen.update(<SelectionList {...defaultProps(root)} inputValue="second" />);
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        // One region stays mounted; the repeated text arrives as a freshly keyed node.
        expect(screen.findByTestId('sl:status') === firstStatus).toBe(true);
        expect(statusText(screen)).toBe('1 · SESSIONS');
        expect(statusEventKey(screen)).not.toBe(firstEventKey);
    });

    it('announces a settled provider with no matches without turning it into an error alert', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'FILES',
            debounceMs: 0,
            resolve: async () => ({ options: [] }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="query" />);

        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });

        const status = screen.findByTestId('sl:status');
        expect(status?.props.role).toBe('status');
        expect(status?.props.role).not.toBe('alert');
        expect(screen.getTextContent()).toContain('FILES · No matches');
    });

    it('announces a provider emptyHint instead of the generic no-matches message', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'MESSAGES',
            debounceMs: 0,
            resolve: async () => ({ options: [], emptyHint: 'Still indexing messages…' }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="query" />);

        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(statusText(screen)).toBe('MESSAGES · Still indexing messages…');
    });

    it('announces a provider notFoundHint through the shared status region', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'FILES',
            debounceMs: 0,
            resolve: async () => ({ options: [], notFound: true, notFoundHint: 'Folder not found.' }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="query" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(statusText(screen)).toBe('FILES · Folder not found.');
    });

    it('announces a static resultHint through the shared status region', async () => {
        const { SelectionList } = await import('../SelectionList');
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [{
                kind: 'static',
                id: 'sessions',
                title: 'SESSIONS',
                options: [],
                resultHint: 'Some Sessions could not be loaded.',
            }],
        };
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="query" />);

        expect(statusText(screen)).toBe(
            'SESSIONS · Some Sessions could not be loaded.',
        );
    });

    it('removes a retired provider announcement with the provider section', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'FILES',
            debounceMs: 0,
            resolve: async () => ({ options: [{ id: 'file', label: 'File' }] }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="query" />);

        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(statusText(screen)).toContain('FILES');

        await act(async () => {
            screen.tree.update(
                <SelectionList
                    {...defaultProps({
                        id: 'root',
                        inputPlaceholder: 'Search',
                        sections: [],
                    })}
                    inputValue="query"
                />,
            );
        });

        expect(statusText(screen)).toBe('');
    });

    it('renders loading skeleton rows while the resolver is pending', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            loadingSkeletonRows: 4,
            // RUX-11.2: explicit opt-in so the section's first-load loading
            // entry surfaces skeletons (the default is now "hide entirely"
            // to avoid the visible-then-hidden flicker — see RenderPlan tests).
            showSkeletonsOnFirstLoad: true,
            resolve: () => new Promise(() => {}),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        // Skeleton rows must surface a dedicated marker; the dynamic section is
        // expected to render either skeleton testIDs or visible placeholder rows.
        const loadingMarker = screen.findByTestId('sl:section:dyn:loading');
        expect(loadingMarker).not.toBeNull();
    });

    it('says it is still looking in one quiet line, instead of skeleton bars, when the section names its loading state', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            showSkeletonsOnFirstLoad: true,
            loadingHint: 'Searching messages…',
            resolve: () => new Promise(() => {}),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
        });
        expect(screen.getTextContent()).toContain('Searching messages…');
        expect(screen.findByTestId('sl:section:dyn:loading:row-0')).toBeNull();
        // The line is the app's in-list state line: it leads with the quiet working ring.
        expect(screen.findByTestId('sl:section:dyn:loading:hint-loading-spinner')).not.toBeNull();
    });

    it('renders a localized inline error without exposing the resolver message', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolve: async () => { throw new Error('boom'); },
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        const errorRow = screen.findByTestId('sl:section:dyn:error');
        expect(errorRow).not.toBeNull();
        const text = screen.getTextContent();
        expect(text).toContain('Something went wrong');
        expect(text).not.toContain('boom');
    });

    it('renders the descriptor emptyHint when resolver succeeds with zero options', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolve: async () => ({ options: [], emptyHint: 'No matches available' }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        const emptyHint = screen.findByTestId('sl:section:dyn:emptyHint');
        expect(emptyHint).not.toBeNull();
        expect(screen.getTextContent()).toContain('No matches available');
    });

    it('renders a result hint after successful options without making the hint an option', async () => {
        const { act } = await import('react-test-renderer');
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resultFiltering: 'provider',
            resolve: async () => ({
                options: [{ id: 'result', label: 'Result' }],
                resultHint: 'More results are available',
            }),
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });

        const hint = screen.findByTestId('sl:section:dyn:resultHint') as unknown as {
            props?: {
                onPress?: unknown;
                disabled?: unknown;
            };
        } | null;
        expect(hint).not.toBeNull();
        expect(hint?.props?.onPress).toBeUndefined();
        expect(screen.getTextContent()).toContain('More results are available');
        expect(statusText(screen)).toContain('More results are available');
        expect(screen.tree.root.findAllByProps({ accessibilityLiveRegion: 'polite' })).toHaveLength(1);
    });

    it('lets Tab descend into an explicitly focused value-mode dynamic row even when ghost text is suppressed', async () => {
        const { act } = await import('react-test-renderer');
        const onSelect = vi.fn();
        const root = makeStep({
            id: 'dyn',
            title: 'DYN',
            debounceMs: 0,
            resolve: async () => ({
                options: [
                    {
                        id: 'projects',
                        label: 'Projects',
                        autocompleteValue: '~/Documents/Projects/',
                        onSelect,
                    },
                ],
            }),
        });
        const { SelectionList } = await import('../SelectionList');
        function Harness(): React.ReactElement {
            const [value, setValue] = React.useState('~/Documents/');
            return (
                <SelectionList
                    {...defaultProps(root, {
                        inputMode: 'value',
                        inputValue: value,
                        onChangeInputValue: setValue,
                        inputBehavior: {
                            getFilterQueryFromInput: () => '',
                            shouldSuppressAutocomplete: () => true,
                        },
                    })}
                />
            );
        }
        const screen = await renderScreen(<Harness />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.findByTestId('sl:root:option:projects')).not.toBeNull();
        await act(async () => {
            await Promise.resolve();
        });

        const initialInput = screen.findByTestId('sl:header:input') as unknown as {
            props: {
                onKeyPress?: (event: unknown) => void;
            };
        } | null;
        expect(initialInput).not.toBeNull();
        if (!initialInput) throw new Error('expected selection list input');

        await act(async () => {
            initialInput.props.onKeyPress?.(makeKeyEvent('ArrowDown'));
        });
        const focusedInput = screen.findByTestId('sl:header:input') as unknown as {
            props: {
                onKeyPress?: (event: unknown) => void;
            };
        } | null;
        expect(focusedInput).not.toBeNull();
        if (!focusedInput) throw new Error('expected selection list input after focus update');
        await act(async () => {
            focusedInput.props.onKeyPress?.(makeKeyEvent('Tab'));
        });

        const updatedInput = screen.findByTestId('sl:header:input') as unknown as {
            props: { value?: string };
        } | null;
        expect(updatedInput?.props.value).toBe('~/Documents/Projects/');
        expect(onSelect).not.toHaveBeenCalled();
    });

    // One cause once: sections that fail for the same named cause say it in one line under the first of them,
    // and the section's own Retry link re-runs every section that line stands for.
    it('says a shared failure cause once and retries every section behind that line', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionListSectionFailure } = await import('../selectionListSectionFailure');
        const calls = { a: 0, b: 0, c: 0 };
        const failing = (id: 'a' | 'b' | 'c', failure: () => Error): SelectionListDynamicSection => ({
            id, title: id.toUpperCase(), debounceMs: 0, retryLabel: 'Retry',
            resolve: async () => { calls[id] += 1; throw failure(); },
        });
        const root: SelectionListStep = {
            id: 'root',
            inputPlaceholder: 'Search',
            sections: [
                { kind: 'dynamic', ...failing('a', () => new SelectionListSectionFailure({ hint: 'Folder is gone', causeKey: 'folder' })) },
                { kind: 'dynamic', ...failing('b', () => new SelectionListSectionFailure({ hint: 'Folder is gone', causeKey: 'folder' })) },
                { kind: 'dynamic', ...failing('c', () => new SelectionListSectionFailure({ hint: 'C failed' })) },
            ],
        };
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.findByTestId('sl:section:a:error')).not.toBeNull();
        expect(screen.findByTestId('sl:section:b:error')).toBeNull();
        expect(screen.findByTestId('sl:section:c:error')).not.toBeNull();
        const text = screen.getTextContent();
        expect(text.split('Folder is gone')).toHaveLength(2);
        expect(text).toContain('C failed');
        expect(calls).toEqual({ a: 1, b: 1, c: 1 });

        await act(async () => screen.pressByTestId('sl:section:a:error:retry'));
        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(calls).toEqual({ a: 2, b: 2, c: 1 });
    });

    it('offers no retry link for a failure that is not retryable', async () => {
        const { act } = await import('react-test-renderer');
        const { SelectionListSectionFailure } = await import('../selectionListSectionFailure');
        const root = makeStep({
            id: 'dyn', title: 'DYN', debounceMs: 0, retryLabel: 'Retry',
            resolve: async () => { throw new SelectionListSectionFailure({ hint: 'Folder is gone', retryable: false }); },
        });
        const { SelectionList } = await import('../SelectionList');
        const screen = await renderScreen(<SelectionList {...defaultProps(root)} inputValue="x" />);
        await act(async () => {
            vi.advanceTimersByTime(1);
            await Promise.resolve();
            await Promise.resolve();
        });
        expect(screen.getTextContent()).toContain('Folder is gone');
        expect(screen.findByTestId('sl:section:dyn:error:retry')).toBeNull();
    });
});
