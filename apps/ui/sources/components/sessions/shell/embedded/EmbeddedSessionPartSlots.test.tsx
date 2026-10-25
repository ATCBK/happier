// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import * as MultiTextInputWeb from '@/components/ui/forms/MultiTextInput.web';
import { EmbeddedSessionStablePartsScope, EmbeddedSessionPartSlotPublication } from './EmbeddedSessionPartSlots';
import { SessionAuthoringComposer } from '@/components/sessions/authoring/SessionAuthoringComposer';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ View: 'div' });
});
// Resolve Metro's web entrypoint lazily without making its real imports await
// the async mock factory for the same platform entrypoint.
vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    get MultiTextInput() { return MultiTextInputWeb.MultiTextInput; },
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const source = React.createContext('missing');
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
    document.body.replaceChildren();
});

it('keeps arrangement slots mounted while producer portals preserve their own contexts', async () => {
    let mounts = 0;
    function Arrangement(props: Readonly<{ transcript: React.ReactNode; composer: React.ReactNode }>) {
        React.useEffect(() => { mounts += 1; }, []);
        return <section>{props.transcript}{props.composer}</section>;
    }
    function ContextReader() { return <span>{React.useContext(source)}</span>; }
    function Producer(props: Readonly<{ name: string; loading: boolean }>) {
        return <source.Provider value={props.name}>
            <EmbeddedSessionPartSlotPublication value={{ transcript: <ContextReader />, placeholder: null,
                composer: props.loading ? null : <SessionAuthoringComposer
                    composerRef={props.name === 'new' ? { kind: 'newSession', instanceId: 'draft' } : { kind: 'session', sessionId: 'created' }}
                    value="Successor draft" onChangeText={() => {}} />,
                state: props.loading ? 'loading' : 'ready', chatBottomSpacing: 'none' }}>
                <span>incorrect fallback</span>
            </EmbeddedSessionPartSlotPublication>
        </source.Provider>;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    const render = (name: string, loading = false) => <EmbeddedSessionStablePartsScope
        renderArrangement={(parts) => <Arrangement transcript={parts.transcript} composer={parts.composer} />}>
        <Producer key={name} name={name} loading={loading} />
    </EmbeddedSessionStablePartsScope>;
    await act(async () => { root.render(render('new')); });
    const section = host.querySelector('section');
    const slot = section?.firstElementChild;
    // The web composer is a contenteditable editor; select part of its draft text.
    const editor = 'textarea, [data-happier-text-input="true"]';
    const input = host.querySelector<HTMLElement>(editor)!;
    input.focus();
    const selection = document.createRange();
    selection.setStart(input.querySelector('p')!.firstChild!, 2);
    selection.setEnd(input.querySelector('p')!.firstChild!, 5);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(selection);
    expect(slot?.textContent).toBe('new');
    await act(async () => { root.render(render('created', true)); });
    // A loading successor has no active input. The draft owner, rather than a
    // parked editor, carries the document to the newly mounted composer.
    expect(host.querySelector(editor)).toBeNull();
    await act(async () => { root.render(render('created')); });
    expect(slot?.textContent).toBe('created');
    expect(host.querySelector('section')).toBe(section);
    expect(section?.firstElementChild).toBe(slot);
    expect(mounts).toBe(1);
    const successor = host.querySelector<HTMLElement>(editor)!;
    expect(successor).not.toBe(input);
    expect(successor.textContent).toBe('Successor draft');
});
