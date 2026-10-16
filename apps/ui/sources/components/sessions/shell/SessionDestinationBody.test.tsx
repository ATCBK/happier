import * as React from 'react';
import { act } from 'react-test-renderer';
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, invokeTestInstanceHandler, renderScreen, standardCleanup } from '@/dev/testkit';
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
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS } from '@happier-dev/protocol/actions/sessionCanvasActionFamily';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';
import { getSessionSplitCanvasRuntimeController, getSessionSplitCanvasRuntimeSnapshot } from '@/components/sessions/canvas/sessionSplitCanvasRuntime';
import { SessionCanvasTabGroup } from '@/components/sessions/canvas/SessionCanvasLeaf';
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

async function measureCanvas(screen: Awaited<ReturnType<typeof renderScreen>>) {
    // Layout is a native/DOM measurement boundary; retain the real canvas and Session children.
    await act(async () => {
        for (const host of screen.findAllHostsByTestId('split-canvas-host')) invokeTestInstanceHandler(host, 'onLayout', {
            nativeEvent: { layout: { x: 0, y: 0, width: 1400, height: 900 } },
        });
    });
    await act(async () => {
        const slots = screen.tree.findAll(node => typeof node.type === 'string'
            && typeof node.props.testID === 'string' && node.props.testID.startsWith('split-canvas-content-slot-'));
        for (const slot of slots) invokeTestInstanceHandler(slot, 'onLayout', {
            nativeEvent: { layout: { x: 0, y: 32, width: 1400, height: 868 } },
        });
    });
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
            await measureCanvas(screen);
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
            await measureCanvas(screen);
            expect(screen.findHostByTestId('session-viewer-host')).not.toBeNull();
            await screen.update(body('companion'));
            await measureCanvas(screen);
            expect(sourceLifetime?.isCurrent()).toBe(false);
            expect(screen.findHostByTestId('session-viewer-host')).toBeNull();
            viewport.width = 390;
            viewport.height = 844;
            await screen.update(body('companion'));
            expect(screen.findHostByTestId('session-viewer-sticky')).toBeNull();
        });
    });

    it('binds an unfocused visible pane Action to its own canvas while preserving the focused publication', async () => {
        await withSessionFixture(async serverId => {
            storage.setState({ isDataReady: true });
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                {['focused', 'companion'].map(id => <DestinationInstanceHost key={id} tabId={id}
                    ref={{ kind: 'session', params: { id, serverId } }} pathname={`/session/${id}`}
                    focused={id === 'focused'} visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                    <SessionDestinationBody />
                </DestinationInstanceHost>)}
            </AppPaneProvider></InjectedAuthProvider>);
            const groups = screen.tree.findAllByType(SessionCanvasTabGroup);
            expect(groups).toHaveLength(2);
            expect(new Set(groups.map(group => group.props.routeProps.mountId)).size).toBe(2);
            const group = groups.find(group => group.props.routeProps.sessionId === 'companion')!;
            const tabId = group.props.leaf.payload.group.activeTabId;
            expect(getSessionSplitCanvasRuntimeSnapshot().routeSessionId).toBe('focused');
            await act(async () => {
                expect(await group.props.requestTabAction('session.canvas.tabs.pin', {
                    scope: group.props.routeProps.entityScope, canvasKey: group.props.routeProps.canvasKey, tabId, pinned: true,
                })).toEqual({ status: 'applied' });
            });
            const current = screen.tree.findAllByType(SessionCanvasTabGroup)
                .find(candidate => candidate.props.routeProps.sessionId === 'companion')!;
            expect(current.props.leaf.payload.tabs[tabId].pinned).toBe(true);
            expect(getSessionSplitCanvasRuntimeSnapshot().routeSessionId).toBe('focused');
            const tabNativeIds = screen.tree.findAll(node => typeof node.type === 'string'
                && typeof node.props.nativeID === 'string' && node.props.nativeID.startsWith('session-canvas-tab-'))
                .map(node => node.props.nativeID);
            expect(new Set(tabNativeIds).size).toBe(tabNativeIds.length);
        });
    });

    it('publishes the focused instance canvas through Actions and retires it when the route closes', async () => {
        await withSessionFixture(async (serverId) => {
            storage.setState({ isDataReady: true });
            const scope = { serverId, accountId: 'account-shell' };
            const target = resolveWorkspaceTargetForSession({ ...scope, sessionId: 'focused' });
            expect(target).not.toBeNull();
            if (!target) throw new Error('Expected the fixture Session workspace');
            const executor = createDefaultActionExecutor();
            const context = { surface: 'ui' as const, authority: 'present_user' as const,
                actionCaller: { kind: 'host' as const }, serverId, expectedAccountId: scope.accountId };
            const input = { scope, canvasKey: target.workspaceCacheKey };
            const screen = await renderScreen(<InjectedAuthProvider credentials={credentials}><AppPaneProvider>
                <DestinationInstanceHost tabId="focused" ref={{ kind: 'session', params: { id: 'focused', serverId } }}
                    pathname="/session/focused" focused visible navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
                    <SessionDestinationBody />
                </DestinationInstanceHost>
            </AppPaneProvider></InjectedAuthProvider>);
            await measureCanvas(screen);
            const listed = await executor.execute('session.canvas.tabs.list', input, context);
            expect(listed.ok).toBe(true);
            if (!listed.ok) throw new Error(`Canvas list refused: ${listed.errorCode}`);
            const outcome = SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS['session.canvas.tabs.list'].parse(listed.result);
            expect(outcome.status).toBe('listed');
            if (outcome.status !== 'listed') throw new Error('Mounted instance did not publish its canvas');
            expect(outcome.tabs.map(tab => tab.address)).toEqual([{ serverId, sessionId: 'focused' }]);
            await act(async () => {
                const opened = await executor.execute('session.canvas.tabs.open', { ...input,
                    sessionId: 'companion', leafId: outcome.leaves[0]!.id, placement: 'center' }, context);
                expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true, result: { status: 'applied' } });
                if (opened.ok) SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS['session.canvas.tabs.open'].parse(opened.result);
            });
            const afterOpen = await executor.execute('session.canvas.tabs.list', input, context);
            if (!afterOpen.ok) throw new Error('Expected canvas after opening another Session');
            expect(SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS['session.canvas.tabs.list'].parse(afterOpen.result))
                .toMatchObject({ status: 'listed', tabs: [
                    { address: { serverId, sessionId: 'focused' } },
                    { address: { serverId, sessionId: 'companion' } },
                ] });
            await screen.unmount();
            expect(getSessionSplitCanvasRuntimeController()).toBeNull();
            const retired = await executor.execute('session.canvas.tabs.list', input, context);
            expect(retired.ok && SESSION_CANVAS_ACTION_OUTPUT_SCHEMAS['session.canvas.tabs.list'].parse(retired.result))
                .toEqual({ status: 'unavailable' });
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
            await measureCanvas(screen);
            expect(getSessionSurfaceVisibilitySnapshot()).toMatchObject({
                focusedSessionId: 'focused', routeAnchorSessionId: 'focused', visibleSessionIds: ['focused', 'companion'],
            });
            expect(getSessionSplitCanvasRuntimeSnapshot().routeSessionId).toBe('focused');
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
            expect(getSessionSplitCanvasRuntimeSnapshot().routeSessionId).toBe('companion');
            await screen.update(body(true));
            expect(getSessionSplitCanvasRuntimeSnapshot().routeSessionId).toBe('focused');
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
