import * as React from 'react';
import { View } from 'react-native';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MultiTextInputHandle } from './MultiTextInput';
import { storage } from '@/sync/domains/state/storage';
const openUrl = vi.hoisted(() => vi.fn(async () => {}));

// The canonical Expo test boundary retains the compiled view's public props and source-offset events.
vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' }, { View: 'View', findNodeHandle: () => 42, Linking: { openURL: openUrl } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

const initialStorageState = storage.getState();
afterEach(async () => {
    await standardCleanup();
    storage.setState(initialStorageState, true);
    openUrl.mockClear();
});

describe('MultiTextInput native composer boundary', () => {
    it('opens a reference through its host binding and a decoration through the shared external URL owner', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const token = formatInlineReferenceTokenV1({ ref: 'session:auth', label: 'Auth' });
        const onOpen = vi.fn();
        const screen = await renderScreen(<MultiTextInput value={token} onChangeText={() => {}}
            references={[{ ref: 'session:auth', token, start: 0, end: token.length, label: 'Auth', kind: 'session', onOpen }]} />);
        const view = screen.tree.findByType('HappierComposerInput');
        await act(async () => {
            view.props.onReferencePress({ nativeEvent: { ref: 'session:auth' } });
            view.props.onDecorationPress({ nativeEvent: { url: 'https://example.test/context' } });
            view.props.onDecorationPress({ nativeEvent: { url: 'javascript:alert(1)' } });
        });
        expect(onOpen).toHaveBeenCalledOnce();
        expect(openUrl.mock.calls).toEqual([['https://example.test/context']]);
    });

    it('restores the typed binding on native undo after the parent drops a deleted reference', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const token = formatInlineReferenceTokenV1({ ref: 'session:auth', label: 'Auth' });
        const reference = { ref: 'session:auth', token, start: 0, end: token.length, kind: 'session', label: 'Auth', binding: { id: 'auth' } };
        const onReferencesChange = vi.fn();
        const screen = await renderScreen(<MultiTextInput value={token} references={[reference]}
            onChangeText={() => {}} onReferencesChange={onReferencesChange} />);
        act(() => screen.tree.findByType('HappierComposerInput').props.onChange({ nativeEvent: {
            text: '', selection: { start: 0, end: 0 }, eventCount: 1, references: [],
        } }));
        await screen.update(<MultiTextInput value="" references={[]} onChangeText={() => {}} onReferencesChange={onReferencesChange} />);
        act(() => screen.tree.findByType('HappierComposerInput').props.onChange({ nativeEvent: {
            text: token, selection: { start: token.length, end: token.length }, eventCount: 2,
            references: [{ ref: reference.ref, token, start: 0, end: token.length }],
        } }));
        expect(onReferencesChange).toHaveBeenLastCalledWith([reference]);
        expect(onReferencesChange.mock.calls.at(-1)?.[0][0].binding).toBe(reference.binding);
    });

    it('keeps full large text editable and uses the exact native UTF16 caret after a middle paste', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const ref = React.createRef<MultiTextInputHandle>();
        const onStateChange = vi.fn();
        const text = `before ${'😀'.repeat(30_000)} after`;
        const caret = text.length - ' after'.length;
        const screen = await renderScreen(<MultiTextInput ref={ref} value="before after"
            onChangeText={() => {}} onStateChange={onStateChange} />);
        act(() => screen.tree.findByType('HappierComposerInput').props.onChange({ nativeEvent: {
            text, selection: { start: caret, end: caret }, eventCount: 1, references: [],
        } }));
        expect(ref.current?.getText()).toBe(text);
        expect(onStateChange).toHaveBeenLastCalledWith({ text, selection: { start: caret, end: caret } });
    });

    it('uses UI font scaling and clamps only the viewport while reporting full content height', async () => {
        storage.setState({ localSettings: { ...storage.getState().localSettings, uiFontScale: 1.25 } });
        const { MultiTextInput } = await import('./MultiTextInput');
        const onContentHeightChange = vi.fn();
        const screen = await renderScreen(<MultiTextInput value="hello" textStyle={{ fontSize: 16 }}
            maxHeight={144} onChangeText={() => {}} onContentHeightChange={onContentHeightChange} />);
        expect(screen.tree.findByType('HappierComposerInput').props.typography.fontSize).toBe(20);
        act(() => screen.tree.findByType('HappierComposerInput').props.onContentHeightChange({ nativeEvent: { height: 260 } }));
        expect(screen.tree.findByType('HappierComposerInput').props.style.height).toBe(144);
        expect(onContentHeightChange).toHaveBeenCalledWith(260);
    });

    it('keeps bound references and editable decoration ranges distinct across the native boundary', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const text = 'see [photo](happier-ref:attachment:picture) next';
        const token = formatInlineReferenceTokenV1({ ref: 'attachment:picture', label: 'photo' });
        const references = [{ start: 4, end: 4 + token.length, token, ref: 'attachment:picture', label: 'Image #1', kind: 'image', state: 'ready' }] as const;
        const decorations = [{ start: 0, end: 3, treatment: 'code', label: 'Code' }] as const;
        const screen = await renderScreen(<MultiTextInput value={text} references={references} decorations={decorations}
            onChangeText={() => {}} accessibilityLabel="Message" accessibilityRole="combobox" accessibilityState={{ expanded: true }} />);
        const view = screen.tree.findByType('HappierComposerInput');
        expect(view.props.value).toBe(text);
        expect(view.props.references).toEqual(references.map(({ token: _token, ...reference }) => ({ ...reference, glyph: 'photo' })));
        expect(view.props.decorations).toEqual(decorations);
        expect(view.props.accessibilityLabel).toBe('Message');
        expect(view.props.accessibilityRole).toBe('combobox');
        expect(view.props.accessibilityState).toEqual({ expanded: true });
        expect(screen.tree.findAllByType('TextInput')).toHaveLength(0);
    });

    it('projects editor-only presentation and source bindings out of the native view props', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const token = formatInlineReferenceTokenV1({ ref: 'session:auth', label: 'Auth' });
        const references = [{ start: 0, end: token.length, ref: 'session:auth', label: 'Auth', kind: 'happier.session',
            token, readableMarker: '@Session "Auth"',
            binding: { kind: 'happier.session', ref: 'session:auth' }, thumbnail: <View />,
            onOpen: () => {},
        }];
        const screen = await renderScreen(<MultiTextInput value={references[0].token} references={references} onChangeText={() => {}} />);
        expect(screen.tree.findByType('HappierComposerInput').props.references).toEqual([{
            start: 0, end: token.length, ref: 'session:auth', label: 'Auth', kind: 'happier.session', marker: '@Session "Auth"', glyph: 'bubble.left',
        }]);
    });

    it('keeps native source selection authoritative for text edits before the controlled echo', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onChangeText = vi.fn();
        const onStateChange = vi.fn();
        const onSelectionChange = vi.fn();
        const ref = React.createRef<MultiTextInputHandle>();
        const screen = await renderScreen(<MultiTextInput ref={ref} value="before after"
            onChangeText={onChangeText} onStateChange={onStateChange} onSelectionChange={onSelectionChange} />);
        const view = screen.tree.findByType('HappierComposerInput');
        await act(async () => {
            view.props.onChange({ nativeEvent: { text: 'before 😀 after', selection: { start: 9, end: 9 }, eventCount: 1, references: [] } });
            view.props.onSelection({ nativeEvent: { selection: { start: 7, end: 9 } } });
        });
        expect(ref.current?.getText()).toBe('before 😀 after');
        expect(ref.current?.flushPendingTextChange()).toBe('before 😀 after');
        expect(onChangeText).toHaveBeenCalledWith('before 😀 after');
        expect(onStateChange).toHaveBeenLastCalledWith({ text: 'before 😀 after', selection: { start: 7, end: 9 } });
        expect(onSelectionChange).toHaveBeenLastCalledWith({ start: 7, end: 9 });
    });

    it('uses the native window-point hit test and imperative drop caret without rerendering', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const ref = React.createRef<MultiTextInputHandle>();
        const native = {
            focus: vi.fn(), blur: vi.fn(), setSelection: vi.fn(), setTextAndSelection: vi.fn(),
            offsetAtPoint: vi.fn(async () => 2), setDropCaret: vi.fn(),
            measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(10, 20, 300, 40),
        };
        await renderScreen(<MultiTextInput ref={ref} value="abc" onChangeText={() => {}} />, {
            createNodeMock: element => element.type === 'HappierComposerInput' ? native : null,
        });
        expect(await ref.current?.offsetAtPoint({ x: 25, y: 35 })).toBe(2);
        ref.current?.setDropCaret(2);
        ref.current?.setDropCaret(null);
        expect(native.offsetAtPoint).toHaveBeenCalledWith(25, 35);
        expect(native.setDropCaret.mock.calls).toEqual([[2], [null]]);
        ref.current?.focus(); ref.current?.blur();
        expect(native.focus).toHaveBeenCalledOnce(); expect(native.blur).toHaveBeenCalledOnce();
        const measured = vi.fn(); ref.current?.measureInWindow(measured);
        expect(measured).toHaveBeenCalledWith(10, 20, 300, 40);
        expect(ref.current?.getReactNodeTag()).toBe(42);
    });

    it('preserves source state for dictation and selection restoration through native commands', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const ref = React.createRef<MultiTextInputHandle>();
        const native = { setTextAndSelection: vi.fn(), setSelection: vi.fn() };
        const onStateChange = vi.fn();
        await renderScreen(<MultiTextInput ref={ref} value="hello" onChangeText={() => {}} onStateChange={onStateChange} />, {
            createNodeMock: element => element.type === 'HappierComposerInput' ? native : null,
        });
        act(() => ref.current?.setTextAndSelection('hello world', { start: 11, end: 11 }));
        expect(ref.current?.getText()).toBe('hello world');
        expect(native.setTextAndSelection).toHaveBeenCalledWith('hello world', { start: 11, end: 11 });
        expect(onStateChange).toHaveBeenLastCalledWith({ text: 'hello world', selection: { start: 11, end: 11 } });
    });

    it('notifies measured height once and preserves native focus, scroll, submit and keyboard events', async () => {
        const { MultiTextInput } = await import('./MultiTextInput');
        const onContentHeightChange = vi.fn(), onScrollYChange = vi.fn(), onFocus = vi.fn(), onBlur = vi.fn();
        const onSubmitEditing = vi.fn(), onKeyPress = vi.fn(() => true);
        const screen = await renderScreen(<MultiTextInput value="hello" onChangeText={() => {}}
            maxHeight={144} initialScrollY={25} scrollRestoreToken="draft-a" submitBehavior="submit"
            onContentHeightChange={onContentHeightChange} onScrollYChange={onScrollYChange}
            onFocus={onFocus} onBlur={onBlur} onSubmitEditing={onSubmitEditing} onKeyPress={onKeyPress} />);
        const view = screen.tree.findByType('HappierComposerInput');
        act(() => {
            view.props.onContentHeightChange({ nativeEvent: { height: 220.4 } });
            view.props.onContentHeightChange({ nativeEvent: { height: 220.4 } });
            view.props.onScroll({ nativeEvent: { y: 25 } }); view.props.onFocus(); view.props.onBlur();
            view.props.onSubmitEditing();
            view.props.onKeyPress({ nativeEvent: { key: 'Enter', shiftKey: true, metaKey: true } });
        });
        expect(onContentHeightChange.mock.calls).toEqual([[221]]);
        expect(onScrollYChange).toHaveBeenCalledWith(25);
        expect(onFocus).toHaveBeenCalledOnce(); expect(onBlur).toHaveBeenCalledOnce();
        expect(onSubmitEditing).toHaveBeenCalledOnce();
        expect(onKeyPress).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter', shiftKey: true, metaKey: true,
            inputState: { text: 'hello', selection: { start: 5, end: 5 } } }));
    });
});
