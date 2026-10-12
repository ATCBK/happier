import * as React from 'react';
import { JSDOM } from 'jsdom';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createTranscriptFindModel } from '@/components/sessions/transcript/find/useTranscriptFind';
import { KeyboardShortcutProvider, useFindSurfaceRegistration, useFindSurfaceRuntime } from './KeyboardShortcutProvider';

const boundary = vi.hoisted(() => ({ platformOS: 'web', subscribe: vi.fn(), configure: vi.fn() }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { get OS() { return boundary.platformOS; }, select: (options: Record<string, unknown>) => options[boundary.platformOS] ?? options.native ?? options.default } });
});
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/components/sessions/agentInput/subscribeToIosHardwareShiftEnter', () => ({
    subscribeToNativeHardwareKeyboardEvents: boundary.subscribe,
    configureNativeHardwareKeyboardConsumableEventSignatures: boundary.configure,
}));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
let environment: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
// jsdom's repository declaration is untyped; narrow the external browser fixture.
let dom: { window: { close(): void; document: Document; KeyboardEvent: typeof KeyboardEvent } };
beforeEach(async () => {
    boundary.platformOS = 'web';
    boundary.subscribe.mockReset().mockReturnValue({ remove: vi.fn() });
    boundary.configure.mockReset();
    environment = await restoreServerAccountForTest({ serverUrl: 'http://find-keys.test' });
    getStorage().setState(state => ({ settings: { ...state.settings, keyboardShortcutsV2Enabled: false,
        keyboardSingleKeyShortcutsEnabled: false, keyboardShortcutDisabledCommandIdsV1: [], keyboardShortcutOverridesV1: {} } }));
    dom = new JSDOM('<!doctype html><textarea></textarea>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('navigator', { platform: 'Linux' });
});
afterEach(async () => {
    standardCleanup();
    await environment.dispose();
    dom.window.close();
    vi.unstubAllGlobals();
});

describe('Find keys with general shortcuts disabled', () => {
    it.each(['web', 'ios', 'android'])('opens in the composer and steps the real model on %s without stealing browser Find or blurred input keys', async platform => {
        boundary.platformOS = platform;
        const model = createTranscriptFindModel({ readCorpus: () => ({ messages: [
            { kind: 'user-text', id: 'm1', localId: null, seq: 1, createdAt: 1, text: 'needle needle needle' },
        ], history: { isLoaded: true, hasOlder: false, isLoadingOlder: false } }), loadPage: null,
            jumpToTarget: async target => ({ status: 'scrolled', target }), reveal: async () => {} });
        model.setQuery('needle');
        await model.settled();
        model.close();
        let focused = true;
        let blur = () => {};
        let submit: (() => void) | undefined;
        function Surface() {
            const opened = React.useSyncExternalStore(model.subscribe, () => model.getSnapshot().open, () => false);
            const [inputFocused, setInputFocused] = React.useState(false);
            blur = () => setInputFocused(false);
            useFindSurfaceRegistration({ surfaceId: 'chat:s1', containsFocus: () => focused,
                isOpen: () => opened, isInputFocused: () => inputFocused,
                open: () => { model.open(); setInputFocused(true); }, controller: model });
            submit = useFindSurfaceRuntime().keyboardHandlers?.onSubmitEditing;
            return null;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        const textarea: HTMLTextAreaElement = dom.window.document.querySelector('textarea')!;
        const dispatch = async (key: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => {
            const event: KeyboardEvent = new dom.window.KeyboardEvent('keydown', { key, code: key === 'f' ? 'KeyF' : key,
                bubbles: true, cancelable: true, ctrlKey: modifiers.ctrl ?? false, metaKey: modifiers.meta ?? false, shiftKey: modifiers.shift ?? false });
            await act(async () => {
                if (platform === 'web') textarea.dispatchEvent(event);
                else boundary.subscribe.mock.calls.at(-1)?.[0]({ key: event.key, code: event.code, repeat: false,
                    modifiers: { ctrl: event.ctrlKey, shift: event.shiftKey, meta: event.metaKey, alt: false } });
                await model.settled();
            });
            return event;
        };
        const mod = platform === 'ios' ? { meta: true } : { ctrl: true };
        const first = await dispatch('f', mod);
        expect(model.getSnapshot().open).toBe(true);
        if (platform === 'web') expect(first.defaultPrevented).toBe(true);
        await dispatch('Enter');
        expect(model.status).toMatchObject({ current: 2, total: 3 });
        await dispatch('Enter', { shift: true });
        expect(model.status).toMatchObject({ current: 1 });
        if (platform !== 'web') {
            await act(async () => { submit?.(); await model.settled(); });
            expect(model.status).toMatchObject({ current: 2 });
        }
        const second = await dispatch('f', mod);
        if (platform === 'web') expect(second.defaultPrevented).toBe(false);
        await act(async () => { blur(); });
        const current = model.status;
        await dispatch('Enter');
        expect(model.status).toEqual(current);
        focused = false;
        await act(async () => { model.close(); });
        await dispatch('f', mod);
        expect(model.getSnapshot().open).toBe(false);
        await screen.unmount();
        model.dispose();
    });
});
