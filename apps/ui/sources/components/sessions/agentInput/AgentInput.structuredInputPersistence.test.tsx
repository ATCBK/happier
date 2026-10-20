import React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import type { ComposerStructuredInputMention } from './structuredInputMentions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type MockSelection = Readonly<{ start: number; end: number }>;
type MockTextInputState = Readonly<{ text: string; selection: MockSelection }>;
type MockMultiTextInputProps = Readonly<{
    value?: string;
    onChangeText?: (text: string) => void;
    onStateChange?: (state: MockTextInputState) => void;
    onKeyPress?: (event: { key: string; shiftKey?: boolean; inputState?: MockTextInputState }) => boolean;
}> & Record<string, unknown>;

const multiTextInputMockState = vi.hoisted(() => ({
    liveText: null as string | null,
    /** Every selection the composer pushed into the input, in order. */
    appliedSelections: [] as Array<Readonly<{ start: number; end: number }>>,
}));

const autocompleteMockState = vi.hoisted(() => ({
    suggestions: [] as Array<{
        kind: 'skill' | 'slashCommand';
        key: string;
        text: string;
        label?: string;
        structuredInput?: Readonly<{
            kind: 'skill';
            name: string;
            displayName?: string;
        }>;
    }>,
    lastQuery: null as string | null,
}));

vi.mock('react-native', async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            ActivityIndicator: (props: Record<string, unknown>) =>
                React.createElement('ActivityIndicator', props, null),
            Platform: {
                OS: 'web',
                select: (value: Record<string, unknown>) => value.web ?? value.default ?? null,
            },
            useWindowDimensions: () => ({ width: 900, height: 600 }),
            Dimensions: {
                get: () => ({ width: 900, height: 600, scale: 1, fontScale: 1 }),
            },
        });
});
vi.mock('@expo/vector-icons', () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
        Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
}));
vi.mock('@/text', async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('react-native-keyboard-controller', () => ({ useFocusedInputHandler: () => {} }));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => {
    const readLiveText = (props: MockMultiTextInputProps): string => multiTextInputMockState.liveText ?? (typeof props.value === 'string' ? props.value : '');
    const MultiTextInput = React.forwardRef((props: MockMultiTextInputProps, ref) => {
        React.useImperativeHandle(ref, () => ({
            setTextAndSelection: (text: string, selection: MockSelection) => {
                multiTextInputMockState.liveText = text;
                props.onChangeText?.(text);
                props.onStateChange?.({ text, selection });
            },
            setSelection: (selection: MockSelection) => {
                multiTextInputMockState.appliedSelections.push(selection);
                const text = readLiveText(props);
                props.onStateChange?.({ text, selection });
            },
            getText: () => readLiveText(props),
            flushPendingTextChange: () => {
                const text = readLiveText(props);
                props.onChangeText?.(text);
                props.onStateChange?.({ text, selection: { start: text.length, end: text.length } });
                return text;
            },
            focus: () => {},
            blur: () => {},
            measureInWindow: () => {},
            getReactNodeTag: () => null,
            getInputElement: () => null,
        }));
        return React.createElement('MultiTextInput', props, null);
    });
    MultiTextInput.displayName = 'MockMultiTextInput';
    return { MultiTextInput };
});

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
}));

vi.mock('@/components/ui/commandMenu', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/ui/commandMenu')>(),
    CommandMenu: () => null,
}));

vi.mock('@/components/ui/popover', () => ({
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: { web: { target: 'body' }, native: true },
    Popover: (props: Record<string, unknown> & { children?: React.ReactNode | ((args: Record<string, unknown>) => React.ReactNode) }) =>
        React.createElement(
            'Popover',
            props,
            typeof props.children === 'function' ? props.children({}) : props.children,
        ),
    PopoverScope: (props: { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('@/components/ui/feedback/Shaker', () => ({
    Shaker: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
}));

const reviewMention = {
    kind: 'skill',
    tokenText: '$review',
    start: 4,
    end: 11,
    name: 'review',
} satisfies ComposerStructuredInputMention;

const staleMention = {
    kind: 'skill',
    tokenText: '$gone',
    start: 12,
    end: 17,
    name: 'gone',
} satisfies ComposerStructuredInputMention;

const selectionRestoreBaseProps = {
    onChangeText: () => {},
    placeholder: 'p',
    onSend: () => {},
    autocompleteKinds: [],
    autocompleteSuggestions: async () => [],
    sessionId: 'session-a',
    metadata: null,
    disabled: false,
    showAbortButton: false,
};

/** A stale word-range, exactly what a double-tap/autocorrect leaves behind. */
const selectionRestorePersistence = {
    initialSelection: { start: 4, end: 11 },
    onScrollYChange: () => {},
    onSelectionChangePersist: () => {},
};

function findMultiTextInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const nodes = screen.findAll((node) => (node.type as unknown) === 'MultiTextInput');
    expect(nodes.length).toBe(1);
    return nodes[0]!;
}

const browser = await installBrowserRuntimeForTests({ url: 'https://composer-structured.test/' });
afterAll(() => browser.restore());
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { getStorage } = await import('@/sync/domains/state/storageStore');
const initialStorageState = getStorage().getState();
beforeEach(() => {
    getStorage().setState({ settings: {
        ...initialStorageState.settings,
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap',
        agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate',
        agentInputHistoryScope: 'perSession',
    } });
});
afterEach(async () => {
    getStorage().setState(initialStorageState, true);
    await home.reset();
});

await import('./AgentInput');

describe('AgentInput structured input persistence', () => {
    afterEach(() => {
        vi.clearAllMocks();
        autocompleteMockState.suggestions = [];
        autocompleteMockState.lastQuery = null;
        multiTextInputMockState.liveText = null;
        multiTextInputMockState.appliedSelections = [];
    });

    it('reconciles controlled structured mentions when the external value changes', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onStructuredInputMentionsChange = vi.fn();
        const baseProps = {
            onChangeText: () => {},
            placeholder: 'p',
            onSend: () => {},
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            sessionId: 'session-a',
            metadata: null,
            disabled: false,
            showAbortButton: false,
            onStructuredInputMentionsChange,
        };
        const screen = await renderScreen(React.createElement(AgentInput, {
            ...baseProps,
            value: 'Ask $review $gone',
            structuredInputMentions: [reviewMention, staleMention],
        }));

        await screen.update(React.createElement(AgentInput, {
            ...baseProps,
            value: 'Ask $review',
            structuredInputMentions: [reviewMention, staleMention],
        }));

        expect(onStructuredInputMentionsChange).toHaveBeenCalledWith([reviewMention]);
        await screen.unmount();
    });

    it('sends selected structured mention metadata before controlled props rerender', async () => {
        autocompleteMockState.suggestions = [{
            kind: 'skill',
            key: 'skill-review',
            text: '$review',
            label: 'Review',
            structuredInput: {
                kind: 'skill',
                name: 'review',
                displayName: 'Review',
            },
        }];
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();
        const onChangeText = vi.fn();
        const onStructuredInputMentionsChange = vi.fn();
        const screen = await renderScreen(React.createElement(AgentInput, {
            value: 'Ask $r',
            onChangeText,
            placeholder: 'p',
            onSend,
            autocompleteKinds: ['skill'] as const,
            autocompleteSuggestions: async () => autocompleteMockState.suggestions,
            sessionId: 'session-a',
            metadata: null,
            disabled: false,
            showAbortButton: false,
            structuredInputMentions: [],
            onStructuredInputMentionsChange,
        }));

        const input = findMultiTextInput(screen);
        await act(async () => { input.props.onFocus?.(); });
        await act(async () => {
            expect(input.props.onKeyPress?.({ key: 'Enter' })).toBe(true);
        });

        expect(onSend).not.toHaveBeenCalled();
        expect(onChangeText).toHaveBeenCalledWith('Ask $review ');
        expect(onStructuredInputMentionsChange).toHaveBeenCalledWith([
            expect.objectContaining({
                kind: 'skill',
                tokenText: '$review',
                start: 4,
                end: 11,
                name: 'review',
            }),
        ]);

        await screen.pressByTestIdAsync('session-composer-send');

        expect(onSend).toHaveBeenCalledWith({
            inputTextOverride: 'Ask $review ',
            structuredInputMetaOverrides: {
                happierStructuredInputV1: {
                    v: 1,
                    skillMentions: [{
                        name: 'review',
                        displayName: 'Review',
                    }],
                },
            },
        });
        await screen.unmount();
    });

    it('keeps autocomplete available for large live input text without pushing the full text into render state', async () => {
        autocompleteMockState.suggestions = [{
            kind: 'slashCommand',
            key: 'slash-run',
            text: '/run',
            label: 'Run',
        }];
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();
        const onChangeText = vi.fn();
        const liveText = `${'x'.repeat(210_000)} /r`;
        multiTextInputMockState.liveText = liveText;
        const screen = await renderScreen(React.createElement(AgentInput, {
            value: '',
            onChangeText,
            placeholder: 'p',
            onSend,
            autocompleteKinds: ['slashCommand'] as const,
            autocompleteSuggestions: async (query: string) => {
                autocompleteMockState.lastQuery = query;
                return autocompleteMockState.suggestions;
            },
            sessionId: 'session-a',
            metadata: null,
            disabled: false,
            showAbortButton: false,
        }));

        const input = findMultiTextInput(screen);
        await act(async () => {
            input.props.onFocus?.();
            input.props.onStateChange?.({
                text: liveText,
                selection: { start: liveText.length, end: liveText.length },
            });
        });

        expect(autocompleteMockState.lastQuery).toBe('/r');

        await act(async () => {
            expect(input.props.onKeyPress?.({
                key: 'Enter',
                inputState: {
                    text: liveText,
                    selection: { start: liveText.length, end: liveText.length },
                },
            })).toBe(true);
        });

        expect(onSend).not.toHaveBeenCalled();
        expect(onChangeText).toHaveBeenLastCalledWith(`${'x'.repeat(210_000)} /run `);
        await screen.unmount();
    });

    it('sends the flushed live input text when controlled props have not caught up', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();
        const onChangeText = vi.fn();
        const liveText = 'x'.repeat(210_000);
        multiTextInputMockState.liveText = liveText;
        const screen = await renderScreen(React.createElement(AgentInput, {
            value: '',
            onChangeText,
            placeholder: 'p',
            onSend,
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            sessionId: 'session-a',
            metadata: null,
            disabled: false,
            showAbortButton: false,
        }));

        const input = findMultiTextInput(screen);
        await act(async () => {
            expect(input.props.onKeyPress?.({
                key: 'Enter',
                inputState: {
                    text: liveText,
                    selection: { start: liveText.length, end: liveText.length },
                },
            })).toBe(true);
        });

        expect(onChangeText).toHaveBeenCalledWith(liveText);
        expect(onSend).toHaveBeenCalledWith({ inputTextOverride: liveText });
        await screen.unmount();
    });

    it('carries the live new-session text in the send event even when controlled props match', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onSend = vi.fn();
        const onChangeText = vi.fn();
        const liveText = 'first prompt owned by the send event';
        multiTextInputMockState.liveText = liveText;
        const screen = await renderScreen(React.createElement(AgentInput, {
            value: liveText,
            onChangeText,
            placeholder: 'p',
            onSend,
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            metadata: null,
            disabled: false,
            showAbortButton: false,
        }));

        const input = findMultiTextInput(screen);
        await act(async () => {
            expect(input.props.onKeyPress?.({
                key: 'Enter',
                inputState: {
                    text: liveText,
                    selection: { start: liveText.length, end: liveText.length },
                },
            })).toBe(true);
        });

        expect(onSend).toHaveBeenCalledWith({ inputTextOverride: liveText });
        await screen.unmount();
    });

    it('restores the persisted selection at open', async () => {
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(React.createElement(AgentInput, {
            ...selectionRestoreBaseProps,
            value: 'Ask $review please',
            inputPersistence: {
                ...selectionRestorePersistence,
                restoreToken: 'session-a:scope:0:pending',
            },
        }));

        expect(multiTextInputMockState.appliedSelections).toEqual([{ start: 4, end: 11 }]);
        await screen.unmount();
    });

    it('never re-applies the persisted selection once the user has edited the draft', async () => {
        // The persisted value is whatever the input last reported, so it can be a
        // RANGE (double-tap, autocorrect, spell-check). Re-applying it after the
        // user types selects an existing word and the next keystroke replaces it,
        // silently corrupting the draft. A later restore generation — the basis
        // latch adopting after an async draft load, or a send-failure rollback —
        // must not resurrect it.
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(React.createElement(AgentInput, {
            ...selectionRestoreBaseProps,
            value: 'Ask $review please',
            inputPersistence: {
                ...selectionRestorePersistence,
                restoreToken: 'session-a:scope:0:pending',
            },
        }));

        const input = findMultiTextInput(screen);
        await act(async () => {
            input.props.onChangeText?.('Ask $review please and more');
        });

        await screen.update(React.createElement(AgentInput, {
            ...selectionRestoreBaseProps,
            value: 'Ask $review please',
            inputPersistence: {
                ...selectionRestorePersistence,
                restoreToken: 'session-a:scope:0:adopted',
            },
        }));

        expect(multiTextInputMockState.appliedSelections).toEqual([{ start: 4, end: 11 }]);
        await screen.unmount();
    });
});
