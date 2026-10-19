import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { Modal } from '@/modal';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { KeyboardShortcutProvider, useKeyboardShortcutHandlers, useFindSurfaceRegistration, useEmbeddedFindKeyboard, useNativeKeyboardInput, useKeyboardCommand } from './KeyboardShortcutProvider';
import { useInboxItemNavigation } from '@/hooks/inbox/useInboxItemNavigation';
import type { InboxItem } from '@/components/inbox/inboxItems';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import { AppPaneProvider, useAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import { buildDetailsWorkspaceStateView } from '@/components/appShell/panes/details/workspace/detailsWorkspaceSelectors';
import { SessionCockpitSurfaceNavigationProvider } from '@/components/workspaceCockpit/session/SessionCockpitSurfaceNavigation';
import { useReviewComposerHandoff } from '@/components/sessions/reviews/comments/useReviewComposerHandoff';
import { ESCAPE_LAYER_PRIORITIES, registerEscapeLayer } from './escape';
import type { NativeHardwareKeyboardEvent } from '@/components/sessions/agentInput/subscribeToIosHardwareShiftEnter';

const testState = vi.hoisted(() => ({
    platformOS: 'web',
}));
const initialSettings = storage.getState().settings;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: {
            get OS() {
                return testState.platformOS;
            },
            select: <T,>(options: { web?: T; ios?: T; android?: T; native?: T; default?: T }) =>
                testState.platformOS === 'web'
                    ? options.web ?? options.default ?? options.native
                    : testState.platformOS === 'ios'
                      ? options.ios ?? options.native ?? options.default
                      : options.android ?? options.native ?? options.default,
        },
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const nativeKeyboardState = vi.hoisted(() => ({
    listeners: new Set<(event: NativeHardwareKeyboardEvent) => void>(),
    enabled: false,
    consumableSignatures: null as readonly string[] | null,
    signaturesAtSubscription: null as readonly string[] | null,
}));

// Only OS delivery is replaced; the real bridge owns subscription lifetime and configuration.
vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal<typeof import('expo-modules-core')>(),
    requireOptionalNativeModule: (name: string) => name === 'HappierHardwareKeyboardShortcuts' ? {
        addListener: (event: string, listener: (event: NativeHardwareKeyboardEvent) => void) => {
            if (event === 'hardwareKey') {
                nativeKeyboardState.listeners.add(listener);
                nativeKeyboardState.signaturesAtSubscription = nativeKeyboardState.consumableSignatures;
            }
            return { remove: () => nativeKeyboardState.listeners.delete(listener) };
        },
        setHardwareKeyEventsEnabled: (enabled: boolean) => { nativeKeyboardState.enabled = enabled; },
        setHardwareKeyConsumableEventSignatures: (signatures: readonly string[]) => {
            nativeKeyboardState.consumableSignatures = [...signatures];
        },
    } : null,
}));

describe('KeyboardShortcutProvider', () => {
    it('opens the exact selected Inbox source anchor through its registered command without settling Needs you', async () => {
        const focus = { kind: 'session', serverId: 'home-a', id: 'source', jumpSeq: 18 } as const;
        const items: readonly InboxItem[] = [{ key: 'source', producer: 'live', type: 'decision', view: 'needs_you',
            title: 'Source', context: null, createdAt: 1, read: false, focus: { kind: 'session', serverId: 'home-a', id: 'source' },
            pageRoute: '/session/source?serverId=home-a', source: { kind: 'session', id: 'source', serverId: 'home-a' } }];
        const open = vi.fn();
        const markOpened = vi.fn(async () => {});
        let execute: ReturnType<typeof useKeyboardCommand> | undefined;
        function Inbox() {
            useInboxItemNavigation({ items, focus, view: 'needs_you', enabled: true,
                select: () => {}, close: () => {}, open, markOpened });
            execute = useKeyboardCommand();
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Inbox /></KeyboardShortcutProvider>);
        await act(async () => { expect(execute?.('inbox.item.open')).toBe(true); });
        expect(open).toHaveBeenCalledWith('/session/source?serverId=home-a&jumpSeq=18');
        expect(markOpened).not.toHaveBeenCalled();
    });
    it('lets a modal own Escape before closing an open Find surface', async () => {
        let opened = true;
        const closeFind = vi.fn(() => { opened = false; });
        const controller: FindController = {
            query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
            capabilities: { regex: true, stop: false },
            setQuery() {}, setOptions() {}, step() {}, stop() {}, close: closeFind,
        };
        function Surface() {
            useFindSurfaceRegistration({
                surfaceId: 'file:leaf', containsFocus: () => true, open: () => { opened = true; },
                isOpen: () => opened, isInputFocused: () => true, controller,
            });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        const closeModal = vi.fn();
        const unregister = registerEscapeLayer({
            priority: ESCAPE_LAYER_PRIORITIES.modal, allowEditableTarget: true, onEscape: closeModal,
        });
        const pressEscape = () => {
            const event = createKeyboardEvent({ key: 'Escape', code: 'Escape' });
            event.preventDefault = () => { Object.defineProperty(event, 'defaultPrevented', { value: true }); };
            window.dispatchEvent(event);
        };
        try {
            await act(async () => { pressEscape(); });
            expect(closeModal).toHaveBeenCalledTimes(1);
            expect(closeFind).not.toHaveBeenCalled();
        } finally { unregister(); }
        await act(async () => { pressEscape(); });
        expect(closeFind).toHaveBeenCalledTimes(1);
    });

    it('routes native keys to the focused input before composer shortcuts and releases them on blur', async () => {
        testState.platformOS = 'ios';
        const insert = vi.fn();
        const send = vi.fn();
        const underlyingSend = vi.fn();
        function Input({ focused }: { focused: boolean }) {
            useNativeKeyboardInput(focused ? {
                bindings: ['Enter', 'Mod+Enter'],
                handleKey: (event) => {
                    if (event.key !== 'Enter') return false;
                    if (event.metaKey) send(); else insert();
                    return true;
                },
            } : null);
            return <Child />;
        }
        const element = (focused: boolean) => <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': underlyingSend }}><Input focused={focused} /></KeyboardShortcutProvider>;
        const screen = await renderScreen(element(true));
        expect(nativeKeyboardState.consumableSignatures).toContain('Enter|shift=false|ctrl=false|meta=false|alt=false');
        const event = { key: 'Enter', repeat: false, modifiers: { shift: false, ctrl: false, meta: true, alt: false } };
        await act(async () => emitNativeKeyboardEvent(event));
        expect(send).toHaveBeenCalledOnce();
        expect(underlyingSend).not.toHaveBeenCalled();
        await act(async () => emitNativeKeyboardEvent({ ...event, modifiers: { ...event.modifiers, meta: false } }));
        expect(insert).toHaveBeenCalledOnce();
        await screen.update(element(false));
        expect(nativeKeyboardState.consumableSignatures).not.toContain('Enter|shift=false|ctrl=false|meta=false|alt=false');
        await act(async () => emitNativeKeyboardEvent(event));
        expect(underlyingSend).toHaveBeenCalledOnce();
    });

    it('gives embedded renderers only configured Find chords and releases disabled bindings', async () => {
        testState.platformOS = 'ios';
        storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutOverridesV1: { 'find.open': [{ binding: 'Mod+P' }] } } });
        let bridge: ReturnType<typeof useEmbeddedFindKeyboard> | undefined;
        const open = vi.fn();
        function Embedded() { bridge = useEmbeddedFindKeyboard(); return <Child />; }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{ 'find.open': open, 'session.new': () => {} }}><Embedded /></KeyboardShortcutProvider>);
        expect(bridge?.signatures).toContain('p|shift=false|ctrl=false|meta=true|alt=false');
        expect(bridge?.signatures.some((signature) => signature.startsWith('g|'))).toBe(false);
        await act(async () => { bridge?.dispatch({ key: 'p', code: 'KeyP', repeat: false, modifiers: { shift: false, ctrl: false, meta: true, alt: false } }); });
        expect(open).toHaveBeenCalledOnce();
        await act(async () => storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutDisabledCommandIdsV1: ['find.open'] } }));
        expect(bridge?.signatures).toEqual([]);
    });
    beforeEach(() => {
        vi.clearAllMocks();
        testState.platformOS = 'web';
        storage.setState({ settings: {
            ...initialSettings,
            commandPaletteEnabled: true,
            keyboardShortcutsV2Enabled: true,
            keyboardSingleKeyShortcutsEnabled: true,
            keyboardShortcutOverridesV1: {},
            keyboardShortcutDisabledCommandIdsV1: [],
        } });
        nativeKeyboardState.enabled = false;
        nativeKeyboardState.consumableSignatures = null;
        nativeKeyboardState.signaturesAtSubscription = null;
        installKeyboardWindowMock();
    });

    afterEach(() => {
        standardCleanup();
        expect(nativeKeyboardState.listeners.size).toBe(0);
        expect(nativeKeyboardState.enabled).toBe(false);
        storage.setState({ settings: initialSettings });
    });

    it('captures handled Find before terminal input, passes the second Find and never steps during composition', async () => {
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        let opened = false;
        let focused = false;
        let steps = 0;
        const controller: FindController = { query: '', options: { matchCase: false, regex: false }, status: { kind: 'idle' }, capabilities: { regex: true, stop: false },
            setQuery() {}, setOptions() {}, step(direction) { steps += direction; }, stop() {}, close() { opened = false; focused = false; } };
        function Surface() {
            const [, refresh] = React.useReducer((value: number) => value + 1, 0);
            useFindSurfaceRegistration({ surfaceId: 'terminal:leaf', containsFocus: () => true, open: () => { opened = true; focused = true; refresh(); }, isOpen: () => opened, isInputFocused: () => focused, controller });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        expect(window.addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), true);
        const first = createKeyboardEvent({ key: 'f', code: 'KeyF', metaKey: true });
        await act(async () => { window.dispatchEvent(first); });
        expect(opened).toBe(true);
        expect(first.preventDefault).toHaveBeenCalledOnce();
        expect(first.stopImmediatePropagation).toHaveBeenCalledOnce();
        const second = createKeyboardEvent({ key: 'f', code: 'KeyF', metaKey: true });
        window.dispatchEvent(second);
        expect(second.preventDefault).not.toHaveBeenCalled();
        window.dispatchEvent(createKeyboardEvent({ key: 'Enter', code: 'Enter', isComposing: true }));
        expect(steps).toBe(0);
        window.dispatchEvent(createKeyboardEvent({ key: 'Enter', code: 'Enter' }));
        expect(steps).toBe(1);
        window.dispatchEvent(createKeyboardEvent({ key: 'Escape', code: 'Escape' }));
        expect(opened).toBe(false);
    });

    it.each(['browser', 'desktop'] as const)('routes Next from an editable field using the %s host chord', async (host) => {
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        if (host === 'desktop') vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async () => undefined });
        let navigations = 0;
        function ShellHost() {
            useKeyboardShortcutHandlers({ 'session.pending.next': () => { navigations += 1; } });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><ShellHost /></KeyboardShortcutProvider>);
        const event = { key: 'j', code: 'KeyJ', shiftKey: true, target: { tagName: 'TEXTAREA' } as unknown as EventTarget };
        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({ ...event, metaKey: host === 'desktop', altKey: host === 'browser' }));
        });
        expect(navigations).toBe(1);
        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({ ...event, metaKey: host === 'browser', altKey: host === 'desktop' }));
            window.dispatchEvent(createKeyboardEvent({ ...event, metaKey: true, shiftKey: false }));
        });
        expect(navigations).toBe(1);
    });

    it('admits the rebound Voice command in an editor but ignores keys consumed by a modal and held-key repeats', async () => {
        storage.setState({ settings: {
            ...storage.getState().settings,
            keyboardShortcutOverridesV1: { 'voice.toggle': [{ binding: 'Ctrl+Alt+B' }] },
        } });
        let toggles = 0;
        function VoiceRuntime() {
            useKeyboardShortcutHandlers({ 'voice.toggle': () => { toggles += 1; } });
            return <Child />;
        }
        const screen = await renderScreen(<KeyboardShortcutProvider handlers={{}}><VoiceRuntime /></KeyboardShortcutProvider>);
        const event = { key: 'b', code: 'KeyB', ctrlKey: true, altKey: true, target: { tagName: 'TEXTAREA' } as unknown as EventTarget };
        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({ ...event, defaultPrevented: true }));
            window.dispatchEvent(createKeyboardEvent({ ...event, repeat: true }));
        });
        expect(toggles).toBe(0);
        await act(async () => { window.dispatchEvent(createKeyboardEvent(event)); });
        expect(toggles).toBe(1);
        await act(async () => { screen.tree.update(<KeyboardShortcutProvider handlers={{}}><Child /></KeyboardShortcutProvider>); });
        await act(async () => { window.dispatchEvent(createKeyboardEvent(event)); });
        expect(toggles).toBe(1);
    });

    it('invokes the current scoped command from an explicit action even when shortcuts are disabled', async () => {
        storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutsV2Enabled: false } });
        const { renderScreen } = await import('@/dev/testkit');
        const module = await import('./KeyboardShortcutProvider');
        let focused = '';
        let invoke: (command: 'composer.focus') => boolean = () => false;
        function Action() {
            invoke = module.useKeyboardCommand();
            return <Child />;
        }
        function Composer({ name }: { name: string }) {
            module.useKeyboardShortcutHandlers({ 'composer.focus': () => { focused = name; } });
            return <Child />;
        }
        const screen = await renderScreen(<module.KeyboardShortcutProvider handlers={{}}><Composer name="first" /><Action /></module.KeyboardShortcutProvider>);
        expect(invoke('composer.focus')).toBe(true);
        expect(focused).toBe('first');
        await act(async () => { screen.tree.update(<module.KeyboardShortcutProvider handlers={{}}><Composer name="second" /><Action /></module.KeyboardShortcutProvider>); });
        invoke('composer.focus');
        expect(focused).toBe('second');
        await act(async () => { screen.tree.update(<module.KeyboardShortcutProvider handlers={{}}><Action /></module.KeyboardShortcutProvider>); });
        expect(invoke('composer.focus')).toBe(false);
    });

    it('hands review back to mobile chat before focusing, preserving tabs without sending', async () => {
        testState.platformOS = 'ios';
        storage.setState({ settings: { ...storage.getState().settings, keyboardShortcutsV2Enabled: false } });
        const { renderScreen } = await import('@/dev/testkit');
        const { KeyboardShortcutProvider } = await import('./KeyboardShortcutProvider');
        type Surface = import('@/components/workspaceCockpit/session/sessionCockpitState').SessionMobileSurface;
        let surface: Surface = 'tabs';
        let focusedSurface: Surface | null = null;
        let sent = 0;
        let handoff = () => {};
        let paneState: ReturnType<typeof useAppPaneContext>['state'] | null = null;
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
        function Probe() {
            const context = useAppPaneContext();
            paneState = context.state;
            handoff = useReviewComposerHandoff('session:s1');
            React.useEffect(() => {
                context.dispatch({ type: 'activateScope', scopeId: 'session:s1' });
                context.dispatch({ type: 'openRight', scopeId: 'session:s1', tabId: 'git' });
                context.dispatch({ type: 'openDetailsTab', scopeId: 'session:s1', tab: { key: 'scmReview:working', kind: 'scmReview', title: 'Review', resource: {} }, openAs: 'pinned' });
                context.dispatch({ type: 'setDetailsTabState', scopeId: 'session:s1', tabKey: 'scmReview:working', nextState: { scrollTop: 120 } });
                context.dispatch({ type: 'enterFocusMode', scopeId: 'session:s1' });
            }, [context.dispatch]);
            return <Child />;
        }
        function Harness() {
            const [activeSurface, setSurface] = React.useState<Surface>('tabs');
            surface = activeSurface;
            return <KeyboardShortcutProvider handlers={{ 'composer.focus': () => { focusedSurface = activeSurface; }, 'composer.sendImmediate': () => { sent += 1; } }}>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface: setSurface, returnToPreviousSurface: () => {} }}>
                    <AppPaneProvider><Probe /></AppPaneProvider>
                </SessionCockpitSurfaceNavigationProvider>
            </KeyboardShortcutProvider>;
        }
        try {
            await renderScreen(<Harness />);
            await act(async () => { handoff(); });
            expect(surface).toBe('chat');
            const state = paneState as ReturnType<typeof useAppPaneContext>['state'] | null;
            expect(state?.focusMode.scopeId).toBeNull();
            expect(state?.scopes['session:s1']?.details.isOpen).toBe(false);
            expect(state?.scopes['session:s1']?.right.isOpen).toBe(false);
            const details = state?.scopes['session:s1']?.details;
            expect(details && buildDetailsWorkspaceStateView(details).tabs.map((tab) => tab.key)).toEqual(['scmReview:working']);
            expect(state?.scopes['session:s1']?.details.tabState['scmReview:working']).toEqual({ scrollTop: 120 });
            expect(focusedSurface).toBeNull();
            await act(async () => { for (const callback of frames) callback(0); });
            expect(focusedSurface).toBe('chat');
            expect(sent).toBe(0);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('omits inactive handler labels from shortcut help', async () => {
        await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: '?',
                code: 'Slash',
                shiftKey: true,
            }));
        });

        expect(Modal.alertAsync).toHaveBeenCalledTimes(1);
        const [, body] = vi.mocked(Modal.alertAsync).mock.calls[0] ?? [];
        expect(String(body)).not.toContain('Command palette');
        expect(String(body)).not.toContain('New session');
    });

    it('routes native hardware keyboard events through the central registry when the native hook is present', async () => {
        testState.platformOS = 'ios';
        const openCommandPalette = vi.fn();

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': openCommandPalette }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.enabled).toBe(true);
        expect(nativeKeyboardState.listeners.size).toBe(1);

        await act(async () => {
            emitNativeKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
                isEditableTarget: false,
            });
        });

        expect(openCommandPalette).toHaveBeenCalledTimes(1);
    });

    it('routes native Cmd+G and Shift+Cmd+G from the focused Find field using the registered commands', async () => {
        testState.platformOS = 'ios';
        const steps: number[] = [];
        const controller: FindController = {
            query: 'needle', options: { matchCase: false, regex: false }, status: { kind: 'idle' },
            capabilities: { regex: true, stop: false }, setQuery() {}, setOptions() {},
            step: (direction) => { steps.push(direction); }, stop() {}, close() {},
        };
        function Surface() {
            useFindSurfaceRegistration({ surfaceId: 'chat', containsFocus: () => true, open() {},
                isOpen: () => true, isInputFocused: () => true, controller });
            return <Child />;
        }
        await renderScreen(<KeyboardShortcutProvider handlers={{}}><Surface /></KeyboardShortcutProvider>);
        expect(nativeKeyboardState.enabled).toBe(true);
        expect(nativeKeyboardState.listeners.size).toBe(1);
        await act(async () => {
            for (const shift of [false, true]) emitNativeKeyboardEvent({ key: 'g', code: 'KeyG',
                modifiers: { shift, ctrl: false, meta: true, alt: false }, repeat: false,
                target: 'reactNativeTextInput', isEditableTarget: true });
        });
        expect(steps).toEqual([1, -1]);
        expect(nativeKeyboardState.consumableSignatures).toEqual(expect.arrayContaining([
            'g|shift=false|ctrl=false|meta=true|alt=false', 'g|shift=true|ctrl=false|meta=true|alt=false',
        ]));
    });

    it('does not dispatch a native shortcut that is disallowed in the focused editable target', async () => {
        testState.platformOS = 'ios';
        const openCommandPalette = vi.fn();

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': openCommandPalette }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.enabled).toBe(true);
        expect(nativeKeyboardState.listeners.size).toBe(1);

        await act(async () => {
            emitNativeKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
            emitNativeKeyboardEvent({
                key: 'k',
                code: 'KeyK',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
                isEditableTarget: true,
            });
        });

        expect(openCommandPalette).not.toHaveBeenCalled();
    });

    it('configures native consumable signatures from active registry bindings before subscribing', async () => {
        testState.platformOS = 'ios';

        await renderScreen(
            <KeyboardShortcutProvider
                handlers={{
                    'composer.sendImmediate': vi.fn(),
                    'composer.abortConfirm': vi.fn(),
                    'commandPalette.open': vi.fn(),
                }}
            >
                <Child />
            </KeyboardShortcutProvider>,
        );

        const signatures = [
            'Escape|shift=true|ctrl=false|meta=false|alt=false',
            'Enter|shift=false|ctrl=false|meta=true|alt=false',
            'k|shift=false|ctrl=false|meta=true|alt=false',
        ];
        expect(nativeKeyboardState.enabled).toBe(true);
        expect(nativeKeyboardState.listeners.size).toBe(1);
        expect(nativeKeyboardState.consumableSignatures).toEqual(signatures);
        expect(nativeKeyboardState.signaturesAtSubscription).toEqual(signatures);
    });

    it('clears native consumable signatures during provider cleanup', async () => {
        testState.platformOS = 'ios';
        const screen = await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.enabled).toBe(true);
        expect(nativeKeyboardState.listeners.size).toBe(1);
        expect(nativeKeyboardState.consumableSignatures).toEqual(['Enter|shift=false|ctrl=false|meta=true|alt=false']);
        await screen.unmount();

        expect(nativeKeyboardState.listeners.size).toBe(0);
        expect(nativeKeyboardState.enabled).toBe(false);
        expect(nativeKeyboardState.consumableSignatures).toEqual([]);
    });

    it('does not subscribe to native keyboard events when V2 is disabled and no compatibility handler can run', async () => {
        testState.platformOS = 'ios';
        storage.setState({ settings: {
            ...storage.getState().settings,
            keyboardShortcutsV2Enabled: false,
        } });

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'session.new': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.listeners.size).toBe(0);
        expect(nativeKeyboardState.enabled).toBe(false);
        expect(nativeKeyboardState.consumableSignatures).toBeNull();
    });

    it('does not subscribe to native keyboard events when no effective handler can match', async () => {
        testState.platformOS = 'ios';
        storage.setState({ settings: {
            ...storage.getState().settings,
            keyboardSingleKeyShortcutsEnabled: false,
            keyboardShortcutDisabledCommandIdsV1: ['commandPalette.open'],
        } });

        await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'commandPalette.open': vi.fn() }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(nativeKeyboardState.listeners.size).toBe(0);
        expect(nativeKeyboardState.enabled).toBe(false);
        expect(nativeKeyboardState.consumableSignatures).toBeNull();
    });

    it('dispatches descendant scoped handlers through the provider registry', async () => {
        testState.platformOS = 'web';
        vi.stubGlobal('navigator', { platform: 'MacIntel' });
        storage.setState({ settings: {
            ...storage.getState().settings,
            keyboardShortcutOverridesV1: {
                'session.new': [{ binding: 'Mod+P' }],
            },
        } });
        const newSession = vi.fn();

        function RegisteredChild() {
            useKeyboardShortcutHandlers(React.useMemo(() => ({
                'session.new': newSession,
            }), []));
            return <Child />;
        }

        await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <RegisteredChild />
            </KeyboardShortcutProvider>,
        );

        await act(async () => {
            window.dispatchEvent(createKeyboardEvent({
                key: 'p',
                code: 'KeyP',
                metaKey: true,
            }));
        });

        expect(newSession).toHaveBeenCalledTimes(1);
    });

    it('updates descendant scoped handler callbacks without re-registering unchanged command keys', async () => {
        testState.platformOS = 'ios';
        const calls: number[] = [];
        let rerenderRegisteredChild: (() => void) | null = null;

        function RegisteredChild() {
            const [version, setVersion] = React.useState(0);
            rerenderRegisteredChild = () => setVersion((current) => current + 1);
            useKeyboardShortcutHandlers(React.useMemo(() => ({
                'composer.sendImmediate': () => calls.push(version),
            }), [version]));
            return <Child />;
        }

        await renderScreen(
            <KeyboardShortcutProvider handlers={{}}>
                <RegisteredChild />
            </KeyboardShortcutProvider>,
        );

        const listener = currentNativeKeyboardListener();

        await act(async () => {
            rerenderRegisteredChild?.();
        });

        expect(currentNativeKeyboardListener()).toBe(listener);

        await act(async () => {
            emitNativeKeyboardEvent({
                key: 'Enter',
                code: 'Enter',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
        });

        expect(calls).toEqual([1]);
    });

    it('updates native root handlers without re-registering unchanged command keys', async () => {
        testState.platformOS = 'ios';
        const firstSendImmediate = vi.fn();
        const secondSendImmediate = vi.fn();

        const screen = await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': firstSendImmediate }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        const listener = currentNativeKeyboardListener();

        await screen.update(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': secondSendImmediate }}>
                <Child />
            </KeyboardShortcutProvider>,
        );

        expect(currentNativeKeyboardListener()).toBe(listener);

        await act(async () => {
            emitNativeKeyboardEvent({
                key: 'Enter',
                code: 'Enter',
                modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                repeat: false,
            });
        });

        expect(firstSendImmediate).not.toHaveBeenCalled();
        expect(secondSendImmediate).toHaveBeenCalledTimes(1);
    });

    it('uses latest native root handlers before passive effects run', async () => {
        testState.platformOS = 'ios';
        const firstSendImmediate = vi.fn();
        const secondSendImmediate = vi.fn();
        function NativeDispatchOnLayout(props: Readonly<{ enabled: boolean }>) {
            React.useLayoutEffect(() => {
                if (!props.enabled) return;
                emitNativeKeyboardEvent({
                    key: 'Enter',
                    code: 'Enter',
                    modifiers: { shift: false, ctrl: false, meta: true, alt: false },
                    repeat: false,
                });
            }, [props.enabled]);
            return <Child />;
        }

        const screen = await renderScreen(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': firstSendImmediate }}>
                <NativeDispatchOnLayout enabled={false} />
            </KeyboardShortcutProvider>,
        );

        const listener = currentNativeKeyboardListener();

        await screen.update(
            <KeyboardShortcutProvider handlers={{ 'composer.sendImmediate': secondSendImmediate }}>
                <NativeDispatchOnLayout enabled />
            </KeyboardShortcutProvider>,
        );

        expect(currentNativeKeyboardListener()).toBe(listener);
        expect(firstSendImmediate).not.toHaveBeenCalled();
        expect(secondSendImmediate).toHaveBeenCalledTimes(1);
    });
});

function Child() {
    return React.createElement('Child');
}

function currentNativeKeyboardListener() {
    expect(nativeKeyboardState.enabled).toBe(true);
    expect(nativeKeyboardState.listeners.size).toBe(1);
    return [...nativeKeyboardState.listeners][0];
}

function emitNativeKeyboardEvent(event: Omit<NativeHardwareKeyboardEvent, 'target'> & { target?: string }) {
    if (!nativeKeyboardState.enabled) return;
    for (const listener of nativeKeyboardState.listeners) {
        listener({ ...event, target: event.target ?? 'reactNativeTextInput' });
    }
}

function installKeyboardWindowMock() {
    const listeners = new Set<(event: KeyboardEvent) => void>();
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: {
            addEventListener: vi.fn((type: string, listener: (event: KeyboardEvent) => void) => {
                if (type === 'keydown') listeners.add(listener);
            }),
            removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
                if (type === 'keydown') listeners.delete(listener);
            },
            dispatchEvent: (event: KeyboardEvent) => {
                for (const listener of listeners) {
                    listener(event);
                }
                return true;
            },
        },
    });
}

function createKeyboardEvent(event: Partial<KeyboardEvent>): KeyboardEvent {
    return {
        key: '',
        code: '',
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        stopImmediatePropagation: vi.fn(),
        target: null,
        ...event,
    } as KeyboardEvent;
}
