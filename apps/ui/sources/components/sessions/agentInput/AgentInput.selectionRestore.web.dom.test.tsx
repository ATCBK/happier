/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';
import type { MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import type { TiptapEditorHTMLElement } from '@tiptap/core';

installAgentInputCommonModuleMocks({ reactNative: async () => await vi.importActual('react-native-web') });
// Select Metro's web implementation; the editor and AgentInput both stay real.
vi.mock('@/components/ui/forms/MultiTextInput', async () => await import('@/components/ui/forms/MultiTextInput.web'));
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const runtime = installSessionPaneRuntimeTestHarness();
const { AgentInput } = await import('./AgentInput');
let root: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(() => {
    Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(25, 35, 0, 18) });
    vi.spyOn(window, 'scrollBy').mockImplementation(() => {});
});
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    container?.remove(); root = null; container = null;
});

describe('AgentInput restored web selection', () => {
    it.each([
        { selection: { start: 6, end: 6 }, ime: false },
        { selection: { start: 6, end: 11 }, ime: false },
        { selection: { start: 6, end: 11 }, ime: true },
    ])('retains the restored selection through host focus and edits/refocus: %j', async ({ selection, ime }) => {
        const ref = React.createRef<MultiTextInputHandle>();
        let focus: (() => void) | null = null;
        const onText = vi.fn();
        function Composer() {
            const [value, setValue] = React.useState('hello world!');
            return <AgentInput ref={ref} value={value} placeholder="Prompt" autocompleteKinds={[]}
                autocompleteSuggestions={async () => []} onChangeText={text => { onText(text); setValue(text); }}
                // A late persisted generation must not replay its old range after an edit.
                inputPersistence={{ restoreToken: `restore:${value}`, initialSelection: selection, onSelectionChangePersist: () => {} }}
                onComposerFocusRequestChange={request => { focus = request; }} />;
        }
        container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
        await act(async () => root!.render(<runtime.Wrapper><Composer /></runtime.Wrapper>));
        const input = container.querySelector<HTMLElement>('[data-happier-text-input]')!;
        expect(input).not.toBeNull();
        await act(async () => { window.getSelection()?.removeAllRanges(); focus?.(); });
        expect(document.activeElement).toBe(input);
        expect(window.getSelection()?.anchorOffset).toBe(selection.start);
        expect(window.getSelection()?.focusOffset).toBe(selection.end);
        const paste = async (text: string) => {
            const event = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'clipboardData', { value: { types: ['text/plain'], files: [], items: [],
                getData: (type: string) => type === 'text/plain' ? text : '' } });
            await act(async () => { input.dispatchEvent(event); });
        };
        if (ime) {
            const editor = (input as TiptapEditorHTMLElement).editor!;
            await act(async () => {
                input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
                editor.view.dispatch(editor.state.tr.insertText('ni'));
            });
            expect(onText).not.toHaveBeenCalled();
            await act(async () => {
                editor.view.dispatch(editor.state.tr.insertText('你', 7, 9));
                input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
                await Promise.resolve();
            });
        } else await paste('new');
        const expected = ime ? 'hello 你!' : selection.start === selection.end ? 'hello newworld!' : 'hello new!';
        expect(onText).toHaveBeenLastCalledWith(expected);
        await act(async () => { ref.current!.blur(); window.getSelection()?.removeAllRanges(); focus?.(); });
        await paste('?');
        expect(ref.current!.getText()).toBe(ime ? 'hello 你?!' : selection.start === selection.end ? 'hello new?world!' : 'hello new?!');
    });
});
