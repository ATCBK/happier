import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSessionPaneUrlSync } from './useSessionPaneUrlSync';
import { renderHook, renderScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { PanePresentationProvider, type PanePresentationIntent } from '@/components/appShell/panes/panePresentation';
import type { DetailsTab } from '@/components/appShell/panes/details/workspace/detailsWorkspaceTypes';
import { deriveSessionPaneUrlStateFromScopeState, type SessionPaneUrlState } from './sessionPaneUrlState';
import { parseSessionPaneUrlState } from './sessionPaneUrlState';
import { createSessionPaneScopeId } from '../sessionPaneScopeId';
import { createWorkspaceState, reduceWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { createWorkspaceNavigationAdapter } from '@/components/appShell/workspace/workspaceNavigationAdapter';
import { hrefForDestinationRef } from '@/components/appShell/destinations/compactAppDestinationCatalog';

// This navigation composition never renders Markdown; the native SDK stays an external boundary.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Markdown SDK is outside this pane URL test'); },
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function Harness(props: any) {
    useSessionPaneUrlSync(props);
    return null;
}

describe('phone pane URL synchronization with the real hook and provider', () => {
    const scopeId = 'session:pane-trap';
    const initialStorageState = storage.getState();
    beforeEach(() => storage.setState(initialStorageState, true));
    afterEach(() => storage.setState(initialStorageState, true));

    const nonUrlTabs = [
        { key: 'plugin:example-team', kind: 'plugin', title: 'Team', resource: { pluginId: 'example-agent', surfaceId: 'team' } },
        { key: 'custom-inspector', kind: 'custom-inspector', title: 'Inspector', resource: {} },
    ] satisfies DetailsTab[];

    it('retains contributed Details in the same Session instance when the phone opens the bare Details route', async () => {
        let workspace = createWorkspaceState({ id: 'other-session-view', pinned: false, preview: false,
            target: { kind: 'session', params: { id: 'pane-trap', serverId: 'home-a', right: 'agents' } } });
        let createdInstances = 0;
        const navigation = createWorkspaceNavigationAdapter({
            getState: () => workspace, getCatalog: () => [],
            dispatch: action => { workspace = reduceWorkspaceState(workspace, action); },
            transport: { commit: () => {} },
            createId: () => ++createdInstances === 1 ? 'phone-session' : 'unexpected-new-instance', onChange: () => {},
        });
        navigation.initialize('/session/pane-trap?serverId=home-a&right=agents');
        navigation.openHref('/session/pane-trap?serverId=home-a&right=agents', { mode: 'newTab' });
        function Wrapper(props: React.PropsWithChildren) { return <AppPaneProvider>{props.children}</AppPaneProvider>; }
        const harness = await renderHook(({ instanceKey, urlState }: { instanceKey: string; urlState: SessionPaneUrlState | null }) => {
            const scopeKey = createSessionPaneScopeId('pane-trap', 'home-a', instanceKey);
            const pane = useAppPaneScope(scopeKey);
            useSessionPaneUrlSync({ enabled: true, browserMirrorsEnabled: false, scopeKey,
                pane, scopeState: pane.scopeState, urlState, setParams: null });
            return pane;
        }, { wrapper: Wrapper, initialProps: { instanceKey: 'phone-session', urlState: { rightTabId: 'agents' } } });
        try {
            await act(async () => harness.getCurrent().openDetailsTab(nonUrlTabs[0], { intent: 'pinned' }));
            // The phone's outer navigation chrome has no source-tab router.
            expect(navigation.openHref('/session/pane-trap/details?serverId=home-a&right=agents')).toBe(true);
            const active = workspace.tabs[workspace.groups[workspace.focusedGroupId].activeTabId];
            expect(active.id).toBe('phone-session');
            expect(active.target).toMatchObject({ kind: 'session', params: { mobileSurface: 'tabs' } });
            const href = new URL(hrefForDestinationRef([], active.target)!, 'https://pane.test');
            expect(href.pathname).toBe('/session/pane-trap/details');
            expect(href.searchParams.get('serverId')).toBe('home-a');
            await harness.rerender({ instanceKey: active.id, urlState: parseSessionPaneUrlState(active.target.params) });
            expect(harness.getCurrent().scopeState?.details.activeTabKey).toBe(nonUrlTabs[0].key);
            expect(harness.getCurrent().scopeState?.details.isOpen).toBe(true);
        } finally { await harness.unmount(); }
    });

    it('hydrates file and terminal links, traverses and remounts without presenting a pane', async () => {
        const presentPane = vi.fn<(intent: PanePresentationIntent) => void>();
        function Wrapper(props: React.PropsWithChildren) {
            return <AppPaneProvider><PanePresentationProvider value={presentPane}>{props.children}</PanePresentationProvider></AppPaneProvider>;
        }
        const file: SessionPaneUrlState = { rightTabId: 'files', details: { kind: 'file', path: 'src/app.ts' } };
        const terminal: SessionPaneUrlState = { rightTabId: 'agents', details: { kind: 'terminal', terminalInstanceId: 'term-7' } };
        const renderPane = (urlState: SessionPaneUrlState) => renderHook(({ urlState }: { urlState: SessionPaneUrlState }) => {
            const pane = useAppPaneScope(scopeId);
            useSessionPaneUrlSync({ enabled: true, browserMirrorsEnabled: false, scopeKey: scopeId,
                pane, scopeState: pane.scopeState, urlState, setParams: null });
            return pane;
        }, { wrapper: Wrapper, initialProps: { urlState } });
        const harness = await renderPane(file);
        try {
            expect(deriveSessionPaneUrlStateFromScopeState(harness.getCurrent().scopeState)).toEqual(file);
            expect(presentPane).not.toHaveBeenCalled();
            await harness.rerender({ urlState: terminal });
            expect(deriveSessionPaneUrlStateFromScopeState(harness.getCurrent().scopeState)).toEqual(terminal);
            expect(presentPane).not.toHaveBeenCalled();
            await harness.rerender({ urlState: file });
            expect(deriveSessionPaneUrlStateFromScopeState(harness.getCurrent().scopeState)).toEqual(file);
            expect(presentPane).not.toHaveBeenCalled();
        } finally {
            await harness.unmount();
        }
        const remounted = await renderPane(terminal);
        try {
            expect(deriveSessionPaneUrlStateFromScopeState(remounted.getCurrent().scopeState)).toEqual(terminal);
            expect(presentPane).not.toHaveBeenCalled();
        } finally {
            await remounted.unmount();
        }
    });

    it('restores stored pane state without presenting a pane', async () => {
        const windowStub = ensurePaneUrlSyncWindow();
        const previousHref = windowStub.location.href;
        const sessionStorage = ensureSessionPaneTestStorage();
        const storageKey = `happier.sessionPaneState.v1:${scopeId}`;
        const previousStored = sessionStorage.getItem(storageKey);
        windowStub.location.href = 'http://localhost:19364/session/pane-trap';
        sessionStorage.setItem(storageKey, JSON.stringify({ right: 'agents', details: 'terminal', terminalInstanceId: 'term-8' }));
        const presentPane = vi.fn<(intent: PanePresentationIntent) => void>();
        function Wrapper(props: React.PropsWithChildren) {
            return <AppPaneProvider><PanePresentationProvider value={presentPane}>{props.children}</PanePresentationProvider></AppPaneProvider>;
        }
        const harness = await renderHook(() => {
            const pane = useAppPaneScope(scopeId);
            useSessionPaneUrlSync({ enabled: true, scopeKey: scopeId, pane, scopeState: pane.scopeState,
                urlState: null, setParams: null });
            return pane;
        }, { wrapper: Wrapper });
        try {
            expect(deriveSessionPaneUrlStateFromScopeState(harness.getCurrent().scopeState)).toEqual({
                rightTabId: 'agents', details: { kind: 'terminal', terminalInstanceId: 'term-8' },
            });
            expect(presentPane).not.toHaveBeenCalled();
        } finally {
            await harness.unmount();
            windowStub.location.href = previousHref;
            if (previousStored === null) sessionStorage.removeItem(storageKey);
            else sessionStorage.setItem(storageKey, previousStored);
        }
    });

    for (const tab of nonUrlTabs) {
        it(`keeps ${tab.kind} Details presented when retained right URL state is applied`, async () => {
            let presented: PanePresentationIntent['pane'] | null = null;
            const presentPane = (intent: PanePresentationIntent) => { presented = intent.pane; };
            function Wrapper(props: React.PropsWithChildren) {
                return <AppPaneProvider><PanePresentationProvider value={presentPane}>{props.children}</PanePresentationProvider></AppPaneProvider>;
            }
            const harness = await renderHook(({ enabled }: { enabled: boolean }) => {
                const pane = useAppPaneScope(scopeId);
                useSessionPaneUrlSync({
                    enabled, browserMirrorsEnabled: false, scopeKey: scopeId,
                    pane, scopeState: pane.scopeState, urlState: { rightTabId: 'agents' }, setParams: null,
                });
                return pane;
            }, { wrapper: Wrapper, initialProps: { enabled: false } });
            try {
                await act(async () => harness.getCurrent().openRight({ tabId: 'agents' }));
                expect(presented).toBe('right');
                await act(async () => harness.getCurrent().openDetailsTab(tab, { intent: 'pinned' }));
                expect(presented).toBe('details');
                await harness.rerender({ enabled: true });
                expect(harness.getCurrent().scopeState?.details.activeTabKey).toBe(tab.key);
                expect(presented).toBe('details');
                await act(async () => harness.getCurrent().setRightTab('agents'));
                expect(presented).toBe('right');
            } finally {
                await harness.unmount();
            }
        });

        it(`does not publish retained right state as a URL for ${tab.kind} Details`, async () => {
            const setParams = vi.fn();
            function Wrapper(props: React.PropsWithChildren) {
                return <AppPaneProvider>{props.children}</AppPaneProvider>;
            }
            const harness = await renderHook(({ enabled }: { enabled: boolean }) => {
                const pane = useAppPaneScope(scopeId);
                const [urlState, setUrlState] = React.useState<SessionPaneUrlState | null>(null);
                const publishParams = React.useCallback((params: Record<string, string | undefined>) => {
                    setParams(params);
                    setUrlState(params.right === 'agents' ? { rightTabId: 'agents' } : null);
                }, []);
                useSessionPaneUrlSync({
                    enabled, browserMirrorsEnabled: false, scopeKey: scopeId,
                    pane, scopeState: pane.scopeState, urlState, setParams: publishParams,
                });
                return pane;
            }, { wrapper: Wrapper, initialProps: { enabled: false } });
            try {
                await act(async () => harness.getCurrent().openRight({ tabId: 'agents' }));
                await act(async () => harness.getCurrent().openDetailsTab(tab, { intent: 'pinned' }));
                await harness.rerender({ enabled: true });
                const scope = harness.getCurrent().scopeState;
                expect(scope?.right.isOpen).toBe(true);
                expect(scope?.details.activeTabKey).toBe(tab.key);
                expect(deriveSessionPaneUrlStateFromScopeState(scope)).toBeNull();
                expect(setParams.mock.calls.some(([params]) => params.right === 'agents')).toBe(false);
            } finally {
                await harness.unmount();
            }
        });
    }
});

function clearSessionPaneTestStorage() {
    const storage = ensureSessionPaneTestStorage();
    storage.clear();
}

type SessionPaneWindowStub = {
    location: { href: string };
    history: {
        state: unknown;
        pushState: (state: unknown, unused: string, url?: string | URL | null) => void;
        replaceState: (state: unknown, unused: string, url?: string | URL | null) => void;
    };
    addEventListener?: (type: string, listener: (event: { type: string }) => void) => void;
    removeEventListener?: (type: string, listener: (event: { type: string }) => void) => void;
    dispatchEvent?: (event: { type: string }) => boolean;
};

function ensureSessionPaneTestStorage() {
    const target = globalThis as typeof globalThis & { sessionStorage?: Storage };
    if (target.sessionStorage) {
        return target.sessionStorage;
    }

    const values = new Map<string, string>();
    const storage = {
        get length() {
            return values.size;
        },
        clear() {
            values.clear();
        },
        getItem(key: string) {
            return values.get(key) ?? null;
        },
        key(index: number) {
            return Array.from(values.keys())[index] ?? null;
        },
        removeItem(key: string) {
            values.delete(key);
        },
        setItem(key: string, value: string) {
            values.set(key, value);
        },
    } satisfies Storage;

    Object.defineProperty(target, 'sessionStorage', {
        configurable: true,
        value: storage,
    });

    return storage;
}

function ensurePaneUrlSyncWindow() {
    const target = globalThis as typeof globalThis & { window?: unknown };

    if (target.window && typeof target.window === 'object') {
        const candidate = target.window as unknown as Partial<SessionPaneWindowStub>;
        if (
            candidate.location
            && typeof candidate.location.href === 'string'
            && candidate.history
            && typeof candidate.history.pushState === 'function'
            && typeof candidate.history.replaceState === 'function'
        ) {
            return candidate as SessionPaneWindowStub;
        }
    }

    const listeners = new Map<string, Set<(event: { type: string }) => void>>();
    const windowStub: SessionPaneWindowStub = {
        location: { href: 'http://localhost:19364/session/test-session?server=http%3A%2F%2Flocalhost%3A53288' },
        history: {
            state: null,
            pushState: vi.fn(),
            replaceState: vi.fn((state: unknown) => {
                windowStub.history.state = state;
            }),
        },
        addEventListener(type: string, listener: (event: { type: string }) => void) {
            const existing = listeners.get(type) ?? new Set<(event: { type: string }) => void>();
            existing.add(listener);
            listeners.set(type, existing);
        },
        removeEventListener(type: string, listener: (event: { type: string }) => void) {
            listeners.get(type)?.delete(listener);
        },
        dispatchEvent(event: { type: string }) {
            for (const listener of listeners.get(event.type) ?? []) {
                listener(event);
            }
            return true;
        },
    };

    Object.defineProperty(target, 'window', {
        configurable: true,
        value: windowStub,
    });

    return windowStub;
}

async function flushDeferredSessionPaneHistoryStateWrite() {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

describe('useSessionPaneUrlSync', () => {
    it('updates a hosted session through its navigation owner without browser or storage mirrors', async () => {
        const windowStub = ensurePaneUrlSyncWindow();
        windowStub.location.href = 'http://localhost:19364/session/other-session?serverId=other-home';
        const pushState = vi.spyOn(windowStub.history, 'pushState');
        const replaceState = vi.spyOn(windowStub.history, 'replaceState');
        pushState.mockClear();
        replaceState.mockClear();
        const storage = ensureSessionPaneTestStorage();
        storage.clear();
        storage.setItem('happier.sessionPaneState.v1:session:test-session', JSON.stringify({ right: 'files' }));
        const storedBefore = storage.getItem('happier.sessionPaneState.v1:session:test-session');
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(), closeRight: vi.fn(), setRightTab: vi.fn(),
            openBottom: vi.fn(), closeBottom: vi.fn(), setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(), closeDetails: vi.fn(),
        };
        const scopeState = {
            right: { isOpen: false, activeTabId: null },
            bottom: { isOpen: false, activeTabId: null },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const props = { enabled: true, browserMirrorsEnabled: false, scopeKey: 'session:test-session', pane, scopeState, urlState: null, setParams };
        const legacy = await renderScreen(<Harness {...props} browserMirrorsEnabled routeParamSyncEnabled={false} />);
        await legacy.unmount();
        pane.openRight.mockClear();
        const screen = await renderScreen(<Harness {...props} />);
        expect(pane.openRight).not.toHaveBeenCalled();
        await screen.update(<Harness {...props} scopeState={{ ...scopeState, right: { isOpen: true, activeTabId: 'git' } }} />);
        await flushDeferredSessionPaneHistoryStateWrite();
        expect(setParams).toHaveBeenCalledWith(expect.objectContaining({ right: 'git' }));
        await screen.update(<Harness {...props} urlState={{ rightTabId: 'files' }} />);
        expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files', present: false });
        windowStub.location.href = 'http://localhost:19364/session/test-session';
        windowStub.dispatchEvent?.(new Event('popstate'));
        expect(pushState).not.toHaveBeenCalled();
        expect(replaceState).not.toHaveBeenCalled();
        expect(storage.getItem('happier.sessionPaneState.v1:session:test-session')).toBe(storedBefore);
    });

    it('pushes a browser history entry for pane changes after the initial mount', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        const pushStateMock = vi.spyOn(windowStub.history, 'pushState');
        windowStub.location.href = 'http://localhost:19364/session/test-session?server=http%3A%2F%2Flocalhost%3A53288';

        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const openBottomScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:test-session"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        expect(pushStateMock).toHaveBeenCalledTimes(0);
        expect(setParams).toHaveBeenCalledTimes(0);

        await screen.update(
                <Harness
                    enabled={true}
                    scopeKey="session:test-session"
                    scopeState={openBottomScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
        );

        expect(pushStateMock).toHaveBeenCalledTimes(1);
        expect(pushStateMock).toHaveBeenCalledWith(
            null,
            '',
            'http://localhost:19364/session/test-session?server=http%3A%2F%2Flocalhost%3A53288&bottom=terminal'
        );
        expect(setParams).toHaveBeenCalledWith({
            right: undefined,
            bottom: 'terminal',
            details: undefined,
            path: undefined,
            sha: undefined,
        });
    });

    it('does not push browser history for the first pane-url sync on mount', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        const pushStateMock = vi.spyOn(windowStub.history, 'pushState');
        windowStub.location.href = 'http://localhost:19364/session/test-session?server=http%3A%2F%2Flocalhost%3A53288';

        const openBottomScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:test-session"
                    scopeState={openBottomScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        expect(pushStateMock).toHaveBeenCalledTimes(0);
        expect(setParams).toHaveBeenCalledWith({
            right: undefined,
            bottom: 'terminal',
            details: undefined,
            path: undefined,
            sha: undefined,
        });
    });

    it('does not write stale session pane params into non-session routes', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        const pushStateMock = vi.spyOn(windowStub.history, 'pushState');
        windowStub.location.href = 'http://localhost:19364/settings/actions/session.list';

        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const fileDetailsScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: {
                isOpen: true,
                activeTabKey: 'file:README.md',
                tabs: [
                    {
                        key: 'file:README.md',
                        kind: 'file',
                        resource: { kind: 'file', path: 'README.md' },
                    },
                ],
            },
        };

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:test-session"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        await screen.update(
                <Harness
                    enabled={true}
                    scopeKey="session:test-session"
                    scopeState={fileDetailsScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
        );

        expect(pushStateMock).toHaveBeenCalledTimes(0);
        expect(setParams).toHaveBeenCalledTimes(0);
        expect(windowStub.location.href).toBe('http://localhost:19364/settings/actions/session.list');
        windowStub.location.href = 'http://localhost:19364/session/test-session?server=http%3A%2F%2Flocalhost%3A53288';
    });

    it('restores the last stored pane state when a session remounts without pane url params', async () => {
        clearSessionPaneTestStorage();

        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:restore-me"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        await screen.unmount();

        pane.openBottom.mockClear();
        pane.setBottomTab.mockClear();

        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:restore-me"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        expect(pane.openBottom).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(pane.setBottomTab).toHaveBeenCalledWith('terminal');
    });

    it('persists pane closures so a later remount does not reopen cleared pane state', async () => {
        clearSessionPaneTestStorage();

        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:close-me"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        await screen.update(
                <Harness
                    enabled={true}
                    scopeKey="session:close-me"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
        );

        await screen.unmount();

        pane.openBottom.mockClear();
        pane.setBottomTab.mockClear();

        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:close-me"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        expect(pane.openBottom).toHaveBeenCalledTimes(0);
        expect(pane.setBottomTab).toHaveBeenCalledTimes(0);
    });

    it('does not restore stored pane state when the current history entry explicitly represents a pane-less url', async () => {
        clearSessionPaneTestStorage();

        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        windowStub.location.href = 'http://localhost:19364/session/restore-me?server=http%3A%2F%2Flocalhost%3A53288';

        const openScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:restore-me"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        await screen.unmount();

        pane.openBottom.mockClear();
        pane.setBottomTab.mockClear();

        windowStub.history.state = {
            id: 'session-entry',
            happierSessionPane: {
                scopeKey: 'session:restore-me',
                urlSig: '|||||',
            },
        };

        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:restore-me"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        expect(pane.openBottom).toHaveBeenCalledTimes(0);
        expect(pane.setBottomTab).toHaveBeenCalledTimes(0);
    });

    it('does not overwrite the stored clean-url pane preference while replaying url-driven pane state', async () => {
        clearSessionPaneTestStorage();

        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const storage = ensureSessionPaneTestStorage();
        const openScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };
        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:history-preference"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        await screen.update(
                <Harness
                    enabled={true}
                    scopeKey="session:history-preference"
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
        );

        expect(storage.getItem('happier.sessionPaneState.v1:session:history-preference')).toBeNull();

        await screen.update(
                <Harness
                    enabled={true}
                    scopeKey="session:history-preference"
                    scopeState={openScopeState}
                    urlState={{ bottomTabId: 'terminal' }}
                    pane={pane}
                    setParams={setParams}
                />
        );

        expect(storage.getItem('happier.sessionPaneState.v1:session:history-preference')).toBeNull();
    });

    it('does not immediately overwrite URL params while applying initial URL state into pane state', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        const urlState = {
            rightTabId: 'files' as const,
            bottomTabId: 'terminal' as const,
            details: { kind: 'commit' as const, sha: 'abc1234' },
        };

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        screen = await renderScreen(<React.StrictMode>
                    <Harness
                        enabled={true}
                        scopeState={closedScopeState}
                        urlState={urlState}
                        pane={pane}
                        setParams={setParams}
                    />
                </React.StrictMode>);

        expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files', present: false });
        expect(pane.openBottom).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(pane.openDetailsTab).toHaveBeenCalledWith(expect.objectContaining({ key: 'commit:abc1234', kind: 'commit' }), { present: false });
        expect(setParams).toHaveBeenCalledTimes(0);

        // Simulate the immediate follow-up render before pane state reflects reconciliation.
        await screen.update(
                <React.StrictMode>
                    <Harness
                        enabled={true}
                        scopeState={closedScopeState}
                        urlState={urlState}
                        pane={pane}
                        setParams={setParams}
                    />
                </React.StrictMode>
        );

        expect(setParams).toHaveBeenCalledTimes(0);

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'commit:abc1234',
                        kind: 'commit',
                        title: 'abc1234',
                        resource: { kind: 'commit', sha: 'abc1234' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'commit:abc1234',
            },
        };

        await screen.update(
                <React.StrictMode>
                    <Harness
                        enabled={true}
                        scopeState={openScopeState}
                        urlState={urlState}
                        pane={pane}
                        setParams={setParams}
                    />
                </React.StrictMode>
        );

        expect(setParams).toHaveBeenCalledTimes(0);
    });

    it('does not close details on initial mount when url state only specifies right', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'scmReview:working',
                        kind: 'scmReview',
                        title: 'Review',
                        resource: { kind: 'scmReview' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'scmReview:working',
            },
        };

        await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:one"
                    scopeState={openScopeState}
                    urlState={{ rightTabId: 'files' }}
                    pane={pane}
                    setParams={setParams}
                />);

        expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files', present: false });

        expect(pane.closeDetails).toHaveBeenCalledTimes(0);
    });

    it('writes state to url, and applies url changes back into pane state', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        windowStub.location.href = 'http://localhost:19364/session/history?server=http%3A%2F%2Flocalhost%3A53288';
        windowStub.history.state = { id: 'history-entry' };

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'file:src/app.ts',
                        kind: 'file',
                        title: 'app.ts',
                        resource: { kind: 'file', path: 'src/app.ts' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'file:src/app.ts',
            },
        };

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:history"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);
        await flushDeferredSessionPaneHistoryStateWrite();

        expect(setParams).toHaveBeenCalledWith({
            right: 'files',
            bottom: 'terminal',
            details: 'file',
            path: 'src/app.ts',
            sha: undefined,
        });
        expect(windowStub.history.state).toEqual({
            id: 'history-entry',
            happierSessionPane: {
                scopeKey: 'session:history',
                urlSig: 'files|terminal|file|src/app.ts||',
            },
        });

        // Simulate our own setParams being reflected back into the route.
        setParams.mockClear();
        await screen.update(
                <Harness
                    enabled={true}
                    scopeKey="session:history"
                    scopeState={openScopeState}
                    urlState={{ rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane}
                    setParams={setParams}
                />
        );

        // No reconciliation should happen for URL updates produced by our own sync.
        expect(pane.closeDetails).toHaveBeenCalledTimes(0);
        expect(pane.closeRight).toHaveBeenCalledTimes(0);
        expect(pane.closeBottom).toHaveBeenCalledTimes(0);

        // Simulate a browser back navigation: URL no longer describes open panes.
        await screen.update(
                <Harness
                    enabled={true}
                    scopeKey="session:history"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />
        );

        // The hook should reconcile pane state to match the URL.
        expect(pane.closeDetails).toHaveBeenCalledTimes(1);
        expect(pane.closeRight).toHaveBeenCalledTimes(1);
        expect(pane.closeBottom).toHaveBeenCalledTimes(1);
    });

    it('preserves terminalInstanceId when syncing terminal details state into route params and history', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        windowStub.location.href = 'http://localhost:19364/session/terminal-history?server=http%3A%2F%2Flocalhost%3A53288';
        windowStub.history.state = { id: 'history-entry' };

        const openScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'terminal:terminal-instance-7',
                        kind: 'terminal',
                        title: 'Terminal',
                        resource: { kind: 'terminal', terminalInstanceId: 'terminal-instance-7' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'terminal:terminal-instance-7',
            },
        };

        await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:terminal-history"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);
        await flushDeferredSessionPaneHistoryStateWrite();

        expect(setParams).toHaveBeenCalledWith({
            right: undefined,
            bottom: undefined,
            details: 'terminal',
            path: undefined,
            sha: undefined,
            terminalInstanceId: 'terminal-instance-7',
        });
        expect(windowStub.history.state).toEqual({
            id: 'history-entry',
            happierSessionPane: {
                scopeKey: 'session:terminal-history',
                urlSig: '||terminal|||terminal-instance-7',
            },
        });
    });

    it('keeps the review comparison in the session link, so reload and back return to the same turn', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        windowStub.location.href = 'http://localhost:19364/session/review-history?server=http%3A%2F%2Flocalhost%3A53288';
        windowStub.history.state = { id: 'history-entry' };
        const reviewTab = {
            key: 'scmReview:working',
            kind: 'scmReview',
            title: 'Files · Turn',
            resource: { kind: 'scmReview', scope: 'working', comparison: { kind: 'turnCheckpoint', turnId: 'turn-4' }, view: 'files' },
            isPinned: true,
            isPreview: false,
        };
        const scopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: true, tabs: [reviewTab], activeTabKey: reviewTab.key },
        };

        const screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:review-history"
                    scopeState={scopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);
        await flushDeferredSessionPaneHistoryStateWrite();
        expect(setParams).toHaveBeenLastCalledWith(expect.objectContaining({
            details: 'scmReview',
            comparison: 'turnCheckpoint',
            turnId: 'turn-4',
            view: 'files',
        }));

        // Back to another turn's link: the pane follows that turn, not whichever turn it showed last.
        await screen.update(<Harness
                    enabled={true}
                    scopeKey="session:review-history"
                    scopeState={scopeState}
                    urlState={{ details: { kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: 'turn-4' }, view: 'files' } }}
                    pane={pane}
                    setParams={setParams}
                />);
        await screen.update(<Harness
                    enabled={true}
                    scopeKey="session:review-history"
                    scopeState={scopeState}
                    urlState={{ details: { kind: 'scmReview', comparison: { kind: 'turnCheckpoint', turnId: 'turn-2' }, view: 'files' } }}
                    pane={pane}
                    setParams={setParams}
                />);
        expect(pane.openDetailsTab).toHaveBeenLastCalledWith(
            expect.objectContaining({ resource: expect.objectContaining({ comparison: { kind: 'turnCheckpoint', turnId: 'turn-2' } }) }),
            { intent: 'pinned', present: false },
        );
    });

    it('does not reconcile (close panes) when switching to a different scope key', async () => {
        const setParams = vi.fn();
        const pane1 = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const pane2 = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'file:src/app.ts',
                        kind: 'file',
                        title: 'app.ts',
                        resource: { kind: 'file', path: 'src/app.ts' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'file:src/app.ts',
            },
        };

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeKey="session:one"
                    scopeState={openScopeState}
                    urlState={{ rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane1}
                    setParams={setParams}
                />);

        // Simulate navigation to a different session route where URL params no longer describe panes.
        // The hook should treat this as a fresh mount for the new scope and must not call close* on
        // the new pane (regression: session navigation closed details unexpectedly).
        await screen.update(
                <Harness
                    enabled={true}
                    scopeKey="session:two"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane2}
                    setParams={setParams}
                />
        );

        expect(pane2.closeDetails).toHaveBeenCalledTimes(0);
        expect(pane2.closeRight).toHaveBeenCalledTimes(0);
        expect(pane2.closeBottom).toHaveBeenCalledTimes(0);
    });

    it('does not apply route params into pane state when route param sync ownership is disabled', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        await renderScreen(<Harness
                    enabled={true}
                    routeParamSyncEnabled={false}
                    scopeKey="session:non-owner"
                    scopeState={closedScopeState}
                    urlState={{ rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane}
                    setParams={setParams}
                />);

        expect(pane.openRight).toHaveBeenCalledTimes(0);
        expect(pane.openBottom).toHaveBeenCalledTimes(0);
        expect(pane.openDetailsTab).toHaveBeenCalledTimes(0);
        expect(setParams).toHaveBeenCalledTimes(0);
    });

    it('does not write pane state back into the URL when route param sync ownership is disabled', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };
        const windowStub = ensurePaneUrlSyncWindow();
        const pushStateMock = vi.spyOn(windowStub.history, 'pushState');
        windowStub.location.href = 'http://localhost:19364/session/non-owner?server=http%3A%2F%2Flocalhost%3A53288';

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'file:src/app.ts',
                        kind: 'file',
                        title: 'app.ts',
                        resource: { kind: 'file', path: 'src/app.ts' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'file:src/app.ts',
            },
        };

        await renderScreen(<Harness
                    enabled={true}
                    routeParamSyncEnabled={false}
                    scopeKey="session:non-owner"
                    scopeState={openScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        expect(pushStateMock).toHaveBeenCalledTimes(0);
        expect(setParams).toHaveBeenCalledTimes(0);
    });

    it('does not write params when url already matches the derived scope state', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const openScopeState = {
            right: { isOpen: true, activeTabId: 'files', tabState: {} },
            bottom: { isOpen: true, activeTabId: 'terminal', tabState: {} },
            details: {
                isOpen: true,
                tabs: [
                    {
                        key: 'file:src/app.ts',
                        kind: 'file',
                        title: 'app.ts',
                        resource: { kind: 'file', path: 'src/app.ts' },
                        isPinned: true,
                        isPreview: false,
                    },
                ],
                activeTabKey: 'file:src/app.ts',
            },
        };

        await renderScreen(<Harness
                    enabled={true}
                    scopeState={openScopeState}
                    urlState={{ rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane}
                    setParams={setParams}
                />);

        expect(setParams).toHaveBeenCalledTimes(0);
    });

    it('re-opens panes when browser forward restores pane params', async () => {
        const setParams = vi.fn();
        const pane = {
            openRight: vi.fn(),
            closeRight: vi.fn(),
            setRightTab: vi.fn(),
            openBottom: vi.fn(),
            closeBottom: vi.fn(),
            setBottomTab: vi.fn(),
            openDetailsTab: vi.fn(),
            closeDetails: vi.fn(),
        };

        const closedScopeState = {
            right: { isOpen: false, activeTabId: null, tabState: {} },
            bottom: { isOpen: false, activeTabId: null, tabState: {} },
            details: { isOpen: false, tabs: [], activeTabKey: null },
        };

        let screen!: Awaited<ReturnType<typeof renderScreen>>;
        screen = await renderScreen(<Harness
                    enabled={true}
                    scopeState={closedScopeState}
                    urlState={null}
                    pane={pane}
                    setParams={setParams}
                />);

        expect(pane.openRight).toHaveBeenCalledTimes(0);
        expect(pane.openDetailsTab).toHaveBeenCalledTimes(0);

        await screen.update(
                <Harness
                    enabled={true}
                    scopeState={closedScopeState}
                    urlState={{ rightTabId: 'files', bottomTabId: 'terminal', details: { kind: 'file', path: 'src/app.ts' } }}
                    pane={pane}
                    setParams={setParams}
                />
        );

        expect(pane.openRight).toHaveBeenCalledWith({ tabId: 'files', present: false });
        expect(pane.openBottom).toHaveBeenCalledWith({ tabId: 'terminal' });
        expect(pane.openDetailsTab).toHaveBeenCalledWith(
            expect.objectContaining({
                key: 'file:src/app.ts',
                kind: 'file',
            }),
            { present: false },
        );
    });
});
