import * as React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, renderScreen, standardCleanup } from '@/dev/testkit';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installShippedNativeFrameScheduler } from '@/dev/testkit/legend/shippedNativeLegendRuntime';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import { storage } from '@/sync/domains/state/storageStore';
import { resetSessionSurfaceVisibilityForTests, getSessionSurfaceVisibilitySnapshot } from '@/sync/domains/session/sessionSurfaceVisibility';
import { SessionDestinationBody } from './SessionDestinationBody';
import { SessionView } from './SessionView';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import '@/sync/syncEngine';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { SessionViewerSourceAccountScopeProvider } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';

// Static Session consumers capture the Socket factory during collection; install
// the canonical external boundary before those imports, then configure it below.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

installDisconnectedServerSocketBoundary();

const viewport = vi.hoisted(() => ({ width: 1400, height: 900 }));

// Native SDK/navigation boundaries only; Session, hydration, pane and activation owners stay real.
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' }, useWindowDimensions: () => viewport });
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: '/session/focused' }).module;
});
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock({ renderInitialNavigatorScreen: true }));
vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
}));

afterEach(async () => {
    viewport.width = 1400;
    viewport.height = 900;
    await standardCleanup();
});
const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-shell' })).toString('base64url')}.signature` };

async function withSessionFixture(run: (serverId: string) => Promise<void>) {
    await prepareSessionDraftPersistenceStorage();
    await loadSyncSingletonForTests();
    const previousState = storage.getState();
    // Bind the real Account/Sync lifecycle while the canonical HTTP and Socket
    // adapters own an unavailable fixture Home. No hydration or admission owner is mocked.
    const account = await restoreServerAccountForTest({
        serverUrl: 'https://shell-test.example', credentials,
        request: async () => Response.json({ error: 'fixture_home_offline' }, { status: 503 }),
    });
    const serverId = account.home.id;
    const frameGlobals = ['requestAnimationFrame', 'cancelAnimationFrame'] as const;
    const previousFrameGlobals = frameGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
    resetSessionSurfaceVisibilityForTests();
    storage.getState().applyMachines([createMachineFixture({ activeAt: Date.now() })]);
    storage.getState().applySessions(['focused', 'companion'].map((id) => createSessionFixture({ id, serverId, active: true })));
    storage.setState({ settings: { ...storage.getState().settings, mobileWorkspaceExperienceV1: 'classic' } });
    storage.setState({ settingsScope: { serverId, accountId: 'account-shell' }, profileScope: { serverId, accountId: 'account-shell' } });
    try {
        installShippedNativeFrameScheduler();
        await run(serverId);
    } finally {
        try {
            await standardCleanup();
        } finally {
            await account.dispose();
            storage.setState(previousState);
            resetSessionSurfaceVisibilityForTests();
            for (const [key, descriptor] of previousFrameGlobals) {
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        }
    }
}

describe('SessionDestinationBody workspace activation', () => {
    it('keeps the open Computer viewer through the real desktop/phone shell replacement and resets for another Session', async () => {
        await withSessionFixture(async serverId => {
            storage.setState({ isDataReady: true, settings: { ...storage.getState().settings, mobileWorkspaceExperienceV1: 'cockpit' } });
            const body = (id = 'focused') => <InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                <DestinationInstanceHost tabId="responsive-viewer" ref={{ kind: 'session', params: { id, serverId } }}
                    pathname={`/session/${id}`} focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                    <SessionDestinationBody />
                </DestinationInstanceHost>
            </AppPaneProvider></InjectedAuthProvider>;
            const screen = await renderScreen(body());
            await screen.pressByTestIdAsync('session-header-computer-button');
            // The local Action actually opened the viewer before the responsive shell is replaced.
            expect(screen.findHostByTestId('session-viewer-host')).not.toBeNull();
            const sourceLifetime = screen.findAllByType(SessionViewerSourceAccountScopeProvider)
                .map(provider => provider.props.accountLifetime).find(lifetime => lifetime?.isCurrent());
            expect(sourceLifetime?.isCurrent()).toBe(true);
            viewport.width = 390;
            viewport.height = 844;
            await screen.update(body());
            // A picker opened by the old shell still borrows this exact viewing authority.
            expect(sourceLifetime?.isCurrent()).toBe(true);
            await vi.waitFor(() => expect(screen.findHostByTestId('session-viewer-sticky')).not.toBeNull());
            viewport.width = 1400;
            viewport.height = 900;
            await screen.update(body());
            expect(screen.findHostByTestId('session-viewer-host')).not.toBeNull();
            await screen.update(body('companion'));
            expect(sourceLifetime?.isCurrent()).toBe(false);
            expect(screen.findHostByTestId('session-viewer-host')).toBeNull();
            viewport.width = 390;
            viewport.height = 844;
            await screen.update(body('companion'));
            expect(screen.findHostByTestId('session-viewer-sticky')).toBeNull();
        });
    });

    it('renders a workspace Session tab as the Session alone, with no tab strip of its own', async () => {
        await withSessionFixture(async serverId => {
            storage.setState({ isDataReady: true });
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                {['focused', 'companion'].map(id => <DestinationInstanceHost key={id} tabId={id}
                    ref={{ kind: 'session', params: { id, serverId } }} pathname={`/session/${id}`}
                    focused={id === 'focused'} visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                    <SessionDestinationBody />
                </DestinationInstanceHost>)}
            </AppPaneProvider></InjectedAuthProvider>);
            // The window's title bar is the only tab rail; a split is the workspace's, never a nested canvas.
            expect(screen.tree.findAll(node => typeof node.type === 'string'
                && (node.props.accessibilityRole === 'tablist' || node.props.role === 'tablist'))).toEqual([]);
            expect(screen.findAllHostsByTestId('split-canvas-host')).toEqual([]);
            expect(screen.findHostByTestId('session-view-retained-surface:focused')).not.toBeNull();
            expect(screen.findHostByTestId('session-view-retained-surface:companion')).not.toBeNull();
        });
    });

    it('presents both visible panes while only the focused pane owns the route anchor across retention', async () => {
        await withSessionFixture(async (serverId) => {
            const body = (companionVisible: boolean, focusedId = 'focused') => <InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                {['focused', 'companion'].map((id) => <DestinationInstanceHost key={id} tabId={id}
                    ref={{ kind: 'session', params: { id, serverId } }} pathname={`/session/${id}`}
                    focused={id === focusedId} visible={id === 'focused' || companionVisible}
                    navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                    <SessionDestinationBody />
                </DestinationInstanceHost>)}
            </AppPaneProvider></InjectedAuthProvider>;
            const screen = await renderScreen(body(true));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused', 'companion'],
            });
            const companionSurface = screen.findHostByTestId('session-view-retained-surface:companion');
            expect(companionSurface?.props.pointerEvents).toBe('auto');
            expect(companionSurface?.props['aria-hidden']).toBe(false);
            await screen.update(body(false));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:companion')).toBe(companionSurface);
            expect(companionSurface?.props.pointerEvents).toBe('none');
            expect(companionSurface?.props['aria-hidden']).toBe(true);
            await screen.update(body(true));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused', 'companion'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:companion')).toBe(companionSurface);
            expect(companionSurface?.props.pointerEvents).toBe('auto');
            await screen.update(body(true, 'companion'));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'companion', routeAnchorSessionId: 'companion', visibleSessionIds: ['focused', 'companion'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:focused')?.props.pointerEvents).toBe('auto');
            await screen.update(body(true));
            await screen.update(body(false, 'companion'));
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: null, routeAnchorSessionId: null, visibleSessionIds: ['focused'],
            });
            expect(screen.findHostByTestId('session-view-retained-surface:focused')?.props.pointerEvents).toBe('auto');
        });
    });

    it('keeps the ordinary route presented before global data readiness without a host override', async () => {
        await withSessionFixture(async (serverId) => {
            storage.setState({ isDataReady: false });
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                <SessionView id="focused" routeServerId={serverId} />
            </AppPaneProvider></InjectedAuthProvider>);
            expect(screen.findHostByTestId('session-view-retained-surface:focused')?.props).toMatchObject({
                pointerEvents: 'auto', 'aria-hidden': false, inert: false,
            });
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused'],
            });
        });
    });
});
