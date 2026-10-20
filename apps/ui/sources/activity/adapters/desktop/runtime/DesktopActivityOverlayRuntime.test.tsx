import * as React from 'react';
import 'fake-indexeddb/auto';
import { IDBObjectStore } from 'fake-indexeddb';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen as renderActivityScreen, standardCleanup } from '@/dev/testkit';
import { ActivityPersonalSessionMembershipProvider } from '@/activity/source/activityPersonalSessionMembership';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { AuthProvider, setCurrentAuth } from '@/auth/context/AuthContext';
import { TokenStorage, type AuthCredentials } from '@/auth/storage/tokenStorage';
import { createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { storage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { StorageState } from '@/sync/store/types';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { scopedSessionLocalStateKey } from '@/sync/domains/state/sessionLocalStateKeys';
import * as actionExecutor from '@/sync/ops/actions/defaultActionExecutor';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol';

import { settingsParse } from '@/sync/domains/settings/settings';

// The overlay is an Account delivery channel, so every candidate is admitted by its
// own Home's persisted Account policy. These Homes stay bound to a stable Account
// identity so the suite exercises the real admission path.
const DESKTOP_OVERLAY_TEST_HOME_SERVER_IDS = ['server-1', 'server-2'] as const;

async function persistDesktopOverlayHomeAccountSettings(): Promise<void> {
    const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
    for (const serverId of DESKTOP_OVERLAY_TEST_HOME_SERVER_IDS) {
        saveAccountSettings({ serverId, accountId: `account-${serverId}` }, settingsParse({}), 1);
    }
}

const sessionsState = vi.hoisted(() => ({
    value: [
        {
            id: 'session-1',
            serverId: 'server-1',
            createdAt: 1,
            updatedAt: 1_000,
            seq: 4,
            lastViewedSessionSeq: 2,
            active: true,
            activeAt: 950,
            archivedAt: null,
            presence: 'online',
            thinking: false,
            thinkingAt: null,
            latestTurnStatus: null,
            latestTurnStatusObservedAt: null,
            meaningfulActivityAt: 1_000,
            lastRuntimeIssue: null,
            lastTurnCompletedAt: null,
            pendingVersion: 1,
            pendingCount: 1,
            pendingPermissionRequestCount: 1,
            pendingUserActionRequestCount: 0,
            pendingRequestObservedAt: 950,
            agentStateVersion: 1,
            agentState: {
                controlledByUser: null,
                requests: {
                    'permission-1': {
                        tool: 'Bash',
                        kind: 'permission',
                        arguments: {},
                        createdAt: 950,
                    },
                },
            },
            metadata: {
                summary: { text: 'Primary session', updatedAt: 1 },
                path: '/Users/tester/project',
                host: 'tester.local',
                homeDir: '/Users/tester',
            },
        },
    ] as Array<Record<string, unknown>>,
}));
const sessionListIndexState = vi.hoisted(() => ({
    value: {
        'server-1': [
            {
                type: 'session',
                sessionId: 'session-1',
                serverId: 'server-1',
            },
        ],
    } as Record<string, Array<{ type: 'session'; sessionId: string; serverId: string }>>,
}));
const concurrentSessionListCacheState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
const sessionListRowsState = vi.hoisted(() => ({
    value: {} as Record<string, Record<string, Record<string, unknown>>>,
}));
const ordinarySessionListMembershipState = vi.hoisted(() => ({
    value: {} as Record<string, readonly string[]>,
}));

function syncCanonicalSessionListState(): void {
    const rowsByServerId: Record<string, Record<string, Record<string, unknown>>> = {};
    const membershipByServerId: Record<string, string[]> = {};
    for (const session of sessionsState.value) {
        const serverId = typeof session.serverId === 'string' && session.serverId.trim()
            ? session.serverId.trim()
            : 'server-1';
        const sessionId = String(session.id);
        (rowsByServerId[serverId] ??= {})[sessionId] = session;
        (membershipByServerId[serverId] ??= []).push(sessionId);
    }
    sessionListRowsState.value = rowsByServerId;
    ordinarySessionListMembershipState.value = membershipByServerId;
}
const localSettingsState = vi.hoisted(() => ({
    value: {
        activitySurfacesEnabled: true,
        iosLiveActivitiesEnabled: true,
        iosWidgetsEnabled: true,
        desktopOverlayEnabled: true,
        desktopOverlayVisibilityMode: 'attention_only',
    } as Record<string, unknown>,
}));
const settingsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));

const syncDesktopActivityOverlayMock = vi.hoisted(
    () => vi.fn<(payload: unknown) => Promise<void>>(async () => {}),
);
const listenDesktopActivityOverlayInteractionMock = vi.hoisted(
    () => vi.fn<(handler: (payload: unknown) => void) => Promise<() => void>>(async () => () => {}),
);
const setDesktopActivityOverlayExpandedMock = vi.hoisted(
    () => vi.fn<(expanded: boolean) => Promise<void>>(async () => {}),
);
const showDesktopMainWindowMock = vi.hoisted(
    () => vi.fn<() => Promise<void>>(async () => {}),
);
const routerPushMock = vi.hoisted(() => vi.fn());
const emitDesktopActivityOverlayInteractionResultMock = vi.hoisted(
    () => vi.fn<(payload: { requestId: string; ok: boolean; errorCode?: string; error?: string }) => Promise<void>>(async () => {}),
);
const actionExecutorExecuteMock = vi.hoisted(
    () => vi.fn<(actionId: string, input: unknown, context: unknown) => void>(),
);
const desktopActivityOverlayQaSyncOverrideKey = '__HAPPIER_DESKTOP_ACTIVITY_OVERLAY_QA_SYNC_OVERRIDE__';

// The real desktop bridge runs above the Tauri event SDK and native IPC ports.
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
        if (event !== 'activityOverlay://interaction') return () => {};
        return listenDesktopActivityOverlayInteractionMock((payload) => handler({ payload }));
    },
}));

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative'))
    .createReactNativeWebMock({ Platform: { OS: 'web' } }));

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router'))
    .createExpoRouterMock({ router: { push: (value: unknown) => routerPushMock(value) } }).module);

const desktopHomes = createHomeGovernanceHarness();
let restoreDesktopBridge = () => {};
let desktopCredentials: AuthCredentials | null = null;

function DesktopAuthFixture({ children }: React.PropsWithChildren): React.ReactElement {
    return <AuthProvider initialCredentials={desktopCredentials}><ActivityPersonalSessionMembershipProvider enabled={false}>
        {children}</ActivityPersonalSessionMembershipProvider></AuthProvider>;
}

function renderScreen(element: Parameters<typeof renderActivityScreen>[0]) {
    return renderActivityScreen(element, { wrapper: DesktopAuthFixture });
}

async function renderSessionHydration(element: Parameters<typeof renderActivityScreen>[0]) {
    const sessions = sessionsState.value;
    const rows = sessionListRowsState.value;
    // Keep the real Home membership while its row bodies hydrate. Account
    // admission can initially publish a withheld snapshot; that bootstrap is
    // outside the fingerprint keeper's one content-publication observation.
    sessionsState.value = [];
    sessionListRowsState.value = {};
    const screen = await renderScreen(element);
    expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({ visible: false }));
    syncDesktopActivityOverlayMock.mockClear();
    await act(async () => {
        sessionsState.value = sessions;
        sessionListRowsState.value = rows;
    });
    await screen.update(element);
    await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0])
        .toMatchObject({ visible: true }));
    return screen;
}

function canonicalSession(input: Record<string, unknown>): Session {
    // Historical test inputs are untyped boundary fixtures. The canonical fixture
    // supplies the actual owner access contract; the viewer producer derives facts.
    const session = createSessionFixture({
        ...input,
        metadata: { machineId: 'machine-1', ...(input.metadata as Session['metadata']) },
    } as Partial<Session>);
    return { ...session, viewer: createSessionOwnerViewerFixture(session) };
}

function publishDesktopFixture(): void {
    const sessions = sessionsState.value.map(canonicalSession);
    const rows: Record<string, Record<string, ReturnType<typeof buildSessionListRenderableFromSession>>> = {};
    for (const [serverId, byId] of Object.entries(sessionListRowsState.value)) {
        rows[serverId] = Object.fromEntries(Object.entries(byId).map(([id, row]) =>
            [id, buildSessionListRenderableFromSession(canonicalSession({ ...row, serverId }))]));
    }
    for (const session of sessions) {
        if (session.serverId) installSessionActionFixture({ homes: desktopHomes, storage, serverId: session.serverId, session });
    }
    storage.setState({
        isDataReady: true,
        sessions: Object.fromEntries(sessions.map((session) => [session.id, session])),
        settings: settingsParse(settingsState.value),
        localSettings: localSettingsParse(localSettingsState.value),
        sessionMessages: {},
        sessionListRowsByServerId: rows,
        ordinarySessionListMembershipByServerId: ordinarySessionListMembershipState.value,
        sessionListIndexByServerId: sessionListIndexState.value,
        concurrentSessionListCacheByServerId: concurrentSessionListCacheState.value as StorageState['concurrentSessionListCacheByServerId'],
    });
}

// All mounted fixture updates go through the actual Zustand owner and selectors.
for (const fixture of [sessionsState, sessionListRowsState, ordinarySessionListMembershipState,
    sessionListIndexState, concurrentSessionListCacheState, localSettingsState, settingsState]) {
    let value = fixture.value;
    Object.defineProperty(fixture, 'value', {
        get: () => value,
        set: (next: typeof value) => { value = next; publishDesktopFixture(); },
    });
}

await loadSyncSingletonForTests();
describe('DesktopActivityOverlayRuntime', () => {
    beforeEach(async () => {
        const secureStorage = createDesktopSecureStorageBoundary();
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command.startsWith('desktop_secure_storage_')) return secureStorage.invoke(command, args);
            if (command === 'desktop_activity_overlay_sync') return syncDesktopActivityOverlayMock(args?.payload);
            if (command === 'desktop_activity_overlay_set_expanded') return setDesktopActivityOverlayExpandedMock(args?.expanded === true);
            if (command === 'desktop_show_main_window') return showDesktopMainWindowMock();
            if (command === 'desktop_activity_overlay_emit_interaction_result') {
                return emitDesktopActivityOverlayInteractionResultMock(args?.payload as Parameters<typeof emitDesktopActivityOverlayInteractionResultMock>[0]);
            }
            throw new Error(`Unexpected desktop IPC command: ${command}`);
        } });
        const desktopBridge = (globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
        restoreDesktopBridge = () => vi.stubGlobal('__TAURI_INTERNALS__', desktopBridge);
        const windowEvents = new EventTarget();
        vi.stubGlobal('window', {
            location: { href: 'https://app.example.test/' },
            addEventListener: windowEvents.addEventListener.bind(windowEvents),
            removeEventListener: windowEvents.removeEventListener.bind(windowEvents),
            dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
            localStorage: globalThis.localStorage,
        });
        for (const serverId of DESKTOP_OVERLAY_TEST_HOME_SERVER_IDS) {
            await desktopHomes.addHome({ name: serverId, serverUrl: `https://${serverId}`,
                accountId: `account-${serverId}`, currentAccount: true, active: serverId === 'server-1' });
            desktopHomes.answer(serverId, '/v2/account/session-delivery-mutes', { body: { scopes: [] } });
        }
        desktopCredentials = await TokenStorage.getCredentialsForServerUrl('https://server-1', { serverId: 'server-1' });
        if (!desktopCredentials) throw new Error('Desktop fixture Home did not persist its Account credential');
        installHomeGovernanceBoundaries(desktopHomes);
        installSessionActionRpcBoundary(() => undefined);
        const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
        // Wait for this restore's readiness, rather than the prior case's bit.
        storage.setState({ isDataReady: false });
        await restoreConnectionToActiveServer(desktopCredentials);
        storage.getState().activateProfileScope({ serverId: 'server-1', accountId: 'account-server-1' });
        await waitForHomeGovernance(() => expect(storage.getState().isDataReady).toBe(true));
        const createExecutor = actionExecutor.createDefaultActionExecutor;
        vi.spyOn(actionExecutor, 'createDefaultActionExecutor').mockImplementation((options) => {
            const executor = createExecutor(options);
            return { ...executor, execute: (...args) => {
                // Call-through observation; no Action result or decision is replaced.
                actionExecutorExecuteMock(...args);
                return executor.execute(...args);
            } };
        });
        await persistDesktopOverlayHomeAccountSettings();
        const now = Date.now();
        syncDesktopActivityOverlayMock.mockImplementation(async () => {});
        listenDesktopActivityOverlayInteractionMock.mockImplementation(async () => () => {});
        setDesktopActivityOverlayExpandedMock.mockImplementation(async () => {});
        showDesktopMainWindowMock.mockImplementation(async () => {});
        emitDesktopActivityOverlayInteractionResultMock.mockImplementation(async () => {});

        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-1',
                createdAt: 1,
                updatedAt: now,
                seq: 4,
                lastViewedSessionSeq: 2,
                active: true,
                activeAt: now - 50,
                archivedAt: null,
                presence: 'online',
                thinking: false,
                thinkingAt: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                meaningfulActivityAt: now,
                lastRuntimeIssue: null,
                lastTurnCompletedAt: null,
                pendingVersion: 1,
                pendingCount: 1,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: now - 50,
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        'permission-1': {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: {},
                            createdAt: now - 50,
                        },
                    },
                },
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 1 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];
        syncCanonicalSessionListState();
        sessionListIndexState.value = {
            'server-1': [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                },
            ],
        };
        sessionListRowsState.value = {
            'server-1': { 'session-1': sessionsState.value[0]! },
        };
        ordinarySessionListMembershipState.value = {
            'server-1': ['session-1'],
        };
        concurrentSessionListCacheState.value = {};
        localSettingsState.value = {
            activitySurfacesEnabled: true,
            iosLiveActivitiesEnabled: true,
            iosWidgetsEnabled: true,
            desktopOverlayEnabled: true,
            desktopOverlayVisibilityMode: 'attention_only',
        };
        settingsState.value = {
        };
    });

    afterEach(async () => {
        standardCleanup();
        const { stopConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        stopConcurrentSessionCacheSync();
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        setCurrentAuth(null);
        desktopCredentials = null;
        delete (globalThis as unknown as Record<string, unknown>)[desktopActivityOverlayQaSyncOverrideKey];
        sessionsState.value = [];
        sessionListIndexState.value = {
            'server-1': [],
        };
        sessionListRowsState.value = {};
        ordinarySessionListMembershipState.value = {};
        concurrentSessionListCacheState.value = {};
        localSettingsState.value = {
            activitySurfacesEnabled: true,
            iosLiveActivitiesEnabled: true,
            iosWidgetsEnabled: true,
            desktopOverlayEnabled: true,
        };
        settingsState.value = {
        };
        syncDesktopActivityOverlayMock.mockReset();
        listenDesktopActivityOverlayInteractionMock.mockReset();
        setDesktopActivityOverlayExpandedMock.mockReset();
        showDesktopMainWindowMock.mockReset();
        emitDesktopActivityOverlayInteractionResultMock.mockReset();
        routerPushMock.mockReset();
        actionExecutorExecuteMock.mockReset();
        vi.useRealTimers();
        vi.restoreAllMocks();
        // The non-desktop case hides this port only for the render; credential
        // rollback must use the same device store that accepted the writes.
        restoreDesktopBridge();
        await desktopHomes.reset();
        vi.unstubAllGlobals();
    });

    it('synchronizes overlay state when running on tauri desktop', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            visible: true,
            model: expect.objectContaining({
                visible: true,
                expanded: expect.objectContaining({
                    cards: expect.arrayContaining([
                        expect.objectContaining({ sessionId: 'session-1' }),
                    ]),
                }),
            }),
        }));
        expect(listenDesktopActivityOverlayInteractionMock).toHaveBeenCalledTimes(1);
    }, 120_000);

    it('consumes the captured Account mute and Undo through the existing census without deleting Work', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(<DesktopActivityOverlayRuntime />);
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true }));
        desktopHomes.answer('server-1', '/v2/account/session-delivery-mutes', {
            body: { scopes: [{ kind: 'source', source: { kind: 'session', sessionId: 'session-1' } }] },
        });
        await act(async () => publishHomeAccountChange('server-1', ['session-follows']));
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: false }));
        expect(storage.getState().sessions['session-1']).toBeDefined();
        desktopHomes.answer('server-1', '/v2/account/session-delivery-mutes', { body: { scopes: [] } });
        await act(async () => publishHomeAccountChange('server-1', ['session-follows']));
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true }));
        await screen.unmount();
    });

    it('skips native sync when the stable activity overview fingerprint is unchanged', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderSessionHydration(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({ visible: true });

        syncDesktopActivityOverlayMock.mockClear();
        localSettingsState.value = {
            ...localSettingsState.value,
        };

        await act(async () => {
            await screen.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
    }, 120_000);

    it('synchronizes disabled desktop overlay policy even when the stable overview fingerprint is unchanged', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderSessionHydration(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledTimes(1);

        syncDesktopActivityOverlayMock.mockClear();
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayEnabled: false,
        };

        await act(async () => {
            await screen.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            visible: false,
            model: expect.objectContaining({
                visible: false,
            }),
        }));
    }, 120_000);

    it('does not use pet desktop overlay settings to host the activity overlay', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayEnabled: false,
            desktopPetOverlayEnabledOverride: 'enabled',
            desktopPetOverlayVisibilityModeOverride: 'alwaysWhenEnabled',
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            visible: false,
            policy: expect.objectContaining({
                enabled: false,
            }),
            model: expect.objectContaining({
                visible: false,
            }),
        }));
    }, 120_000);

    it('honors the pinned MCP QA sync payload instead of overwriting it with live rows', async () => {
        const qaPayload = {
            visible: true,
            expanded: true,
            model: {
                visible: true,
                isExpanded: true,
                generatedAt: 1,
                collapsed: {
                    title: 'Quota update',
                    statusText: 'Usage summary',
                    defaultTarget: 'open-inbox',
                    sessionCount: null,
                    primaryCardKind: 'quota_summary',
                },
                expanded: {
                    title: 'Usage',
                    rows: [],
                    cards: [
                        {
                            id: 'qa-quota-summary',
                            kind: 'quota_summary',
                            title: '5h left today',
                            summary: '7% remaining in the rolling window.',
                        },
                    ],
                },
                window: {
                    collapsed: { width: 336, height: 68 },
                    expanded: { width: 408, height: 232 },
                },
            },
            policy: localSettingsState.value,
            window: {
                collapsed: { width: 336, height: 68 },
                expanded: { width: 408, height: 232 },
            },
        };
        (globalThis as unknown as Record<string, unknown>)[desktopActivityOverlayQaSyncOverrideKey] = {
            payload: qaPayload,
            expiresAt: Date.now() + 30_000,
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            expanded: true,
            model: expect.objectContaining({
                expanded: expect.objectContaining({
                    cards: [expect.objectContaining({ kind: 'quota_summary' })],
                }),
            }),
        }));
        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalledWith(expect.objectContaining({
            model: expect.objectContaining({
                expanded: expect.objectContaining({
                    cards: [expect.objectContaining({ kind: 'session_overview' })],
                }),
            }),
        }));
    }, 120_000);

    it('uses the desktop overlay selection path instead of widget mode when choosing visible sessions', async () => {
        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-1',
                seq: 4,
                lastViewedSessionSeq: 2,
                active: true,
                presence: 'online',
                thinking: false,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 1 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
            {
                id: 'session-2',
                serverId: 'server-1',
                seq: 5,
                lastViewedSessionSeq: 1,
                active: false,
                presence: 1,
                thinking: false,
                pendingPermissionRequestCount: 0,
                pendingUserActionRequestCount: 1,
                metadata: {
                    summary: { text: 'Question session', updatedAt: 2 },
                    path: '/Users/tester/project-two',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];
        syncCanonicalSessionListState();
        sessionListIndexState.value = {
            'server-1': [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-1',
                },
                {
                    type: 'session',
                    sessionId: 'session-2',
                    serverId: 'server-1',
                },
            ],
        };
        localSettingsState.value = {
            ...localSettingsState.value,
            widgetsPresetMode: 'attention',
            desktopOverlayVisibilityMode: 'active_sessions',
            desktopOverlayShowWhenRunning: true,
            desktopOverlayShowWhenAttentionRequired: true,
            desktopOverlayShowWhenReady: true,
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).toHaveBeenCalledWith(expect.objectContaining({
            model: expect.objectContaining({
                expanded: expect.objectContaining({
                    rows: [expect.objectContaining({ sessionId: 'session-1' })],
                }),
            }),
        }));
    });

    it('does not synchronize when not running on tauri', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        expect(listenDesktopActivityOverlayInteractionMock).not.toHaveBeenCalled();
    });

    it('does not synchronize when rendering inside the overlay window context', async () => {
        window.location.href = 'https://app.example.test/desktop/activity-overlay';
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(syncDesktopActivityOverlayMock).not.toHaveBeenCalled();
        expect(listenDesktopActivityOverlayInteractionMock).not.toHaveBeenCalled();
    });

    it('routes overlay interactions to the selected session and collapses afterward', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'open-session:session-1',
                data: {
                    serverId: 'server-1',
                    sessionId: 'session-1',
                },
            });
        });

        expect(showDesktopMainWindowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1?serverId=server-1');
        expect(showDesktopMainWindowMock.mock.invocationCallOrder[0]).toBeLessThan(
            routerPushMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('executes direct permission, user-action, and quick-reply overlay interactions through the canonical action executor', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.permission.respond',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    requestId: 'permission-1',
                    decision: 'allow',
                },
            });
            handler?.({
                actionIdentifier: 'session.user_action.answer',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    requestId: 'question-1',
                    answers: [
                        {
                            question: 'Which deployment target?',
                            answer: 'Production',
                        },
                    ],
                },
            });
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    message: 'Continue',
                },
            });
        });

        const permissionCall = actionExecutorExecuteMock.mock.calls.find(([actionId]) => actionId === 'session.permission.respond');
        expect(permissionCall?.[1]).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            requestId: 'permission-1',
            decision: 'allow',
        }));
        expect(permissionCall?.[1]).not.toHaveProperty('serverId');
        expect(permissionCall?.[2]).toEqual(
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        const userActionCall = actionExecutorExecuteMock.mock.calls.find(([actionId]) => actionId === 'session.user_action.answer');
        expect(userActionCall?.[1]).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            requestId: 'question-1',
            answers: [
                {
                    question: 'Which deployment target?',
                    answer: 'Production',
                },
            ],
        }));
        expect(userActionCall?.[1]).not.toHaveProperty('serverId');
        expect(userActionCall?.[2]).toEqual(
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        const quickReplyCall = actionExecutorExecuteMock.mock.calls.find(([actionId]) => actionId === 'session.message.send');
        expect(quickReplyCall?.[1]).toEqual(expect.objectContaining({
            sessionId: 'session-1',
            message: 'Continue',
        }));
        expect(quickReplyCall?.[1]).not.toHaveProperty('serverId');
        expect(quickReplyCall?.[2]).toEqual(
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('opens the session instead of executing a direct action when the payload lacks verified server scope', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    message: 'Continue',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
        expect(showDesktopMainWindowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1?serverId=server-1');
        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('does not open an unqualified session when two Homes use the same session id', async () => {
        // The real list runtime retires unselected Home membership. Admit both
        // Homes before seeding their retained rows and awaiting channel policy.
        await desktopHomes.selectHomes(['server-1', 'server-2']);
        const { startConcurrentSessionCacheSync } = await import('@/sync/runtime/orchestration/concurrentSessionCache');
        startConcurrentSessionCacheSync();
        await waitForHomeGovernance(() => expect(storage.getState().concurrentSessionListCacheByServerId['server-2']).toBeDefined());
        const { saveAccountSettings } = await import('@/sync/domains/state/accountSettingsPersistence');
        saveAccountSettings({ serverId: 'server-1', accountId: 'account-server-1' }, settingsParse({
            attentionDeliveryPolicyV1: { v: 1, channels: { desktop_overlay: { enabled: false } } },
        }), 2);
        const secondarySession = {
            ...sessionsState.value[0],
            serverId: 'server-2',
            metadata: {
                ...sessionsState.value[0]?.metadata as Record<string, unknown>,
                summary: { text: 'Secondary Home session', updatedAt: 2 },
            },
        };
        sessionsState.value = [secondarySession];
        concurrentSessionListCacheState.value = {};
        sessionListRowsState.value = {
            'server-1': {
                'session-1': {
                    ...secondarySession,
                    serverId: 'server-1',
                    metadata: {
                        ...secondarySession.metadata as Record<string, unknown>,
                        summary: { text: 'Primary Home session', updatedAt: 1 },
                    },
                },
            },
            'server-2': { 'session-1': secondarySession },
        };
        ordinarySessionListMembershipState.value = {
            'server-1': ['session-1'],
            'server-2': ['session-1'],
        };
        sessionListIndexState.value = {
            'server-1': [{ type: 'session', sessionId: 'session-1', serverId: 'server-1' }],
            'server-2': [{ type: 'session', sessionId: 'session-1', serverId: 'server-2' }],
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0]).toMatchObject({
            model: { expanded: { rows: [expect.objectContaining({ sessionId: 'session-1', serverId: 'server-2' })] } },
        }));
        const syncedModel = syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0] as {
            model?: { expanded?: { rows?: Array<{ sessionId: string; serverId: string | null }> } };
        } | undefined;
        // The first Home opted out of this channel, but its row remains in the
        // qualified source. An admitted snapshot is not proof that a bare id is
        // unique across the complete source used by the interaction boundary.
        expect(syncedModel?.model?.expanded?.rows).toEqual([
            expect.objectContaining({ sessionId: 'session-1', serverId: 'server-2' }),
        ]);

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;
        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    message: 'Continue',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
        expect(showDesktopMainWindowMock).not.toHaveBeenCalled();
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('does not preserve legacy permission notification action execution in the desktop overlay', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.permissionAllowV1,
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    requestId: 'permission-1',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
    });

    it('acknowledges downstream direct action failure back to the overlay request', async () => {
        // A definitive pre-dispatch device-storage failure must reach the overlay.
        // A lost Pending HTTP response is not equivalent: durable outbox custody
        // deliberately reports uncertainty instead of manufacturing a failed send.
        const outboxKey = scopedSessionLocalStateKey('session-pending-outbox-v1', {
            serverId: 'server-1', accountId: 'account-server-1',
        });
        const getRecord = IDBObjectStore.prototype.get;
        vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
            if (key === outboxKey) throw new Error('action_failed');
            return getRecord.call(this, key);
        });
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { requestId?: string; actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                requestId: 'quick-reply-request-1',
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-1',
                    message: 'Continue',
                },
            });
            await Promise.resolve();
        });

        expect(actionExecutorExecuteMock).toHaveBeenCalledWith(
            'session.message.send',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'Continue',
            }),
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-1',
            }),
        );
        expect(actionExecutorExecuteMock.mock.calls[0]?.[1]).not.toHaveProperty('serverId');
        await waitForHomeGovernance(() => expect(emitDesktopActivityOverlayInteractionResultMock).toHaveBeenCalledWith({
            requestId: 'quick-reply-request-1',
            ok: false,
            errorCode: 'action_failed',
            error: 'action_failed',
        }));
    });

    it('uses the canonical shared default target when the interaction has no explicit action identifier', async () => {
        localSettingsState.value = {
            ...localSettingsState.value,
            activitySurfaceTapTarget: 'open_sessions',
        };
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: ' ',
                data: {
                    primarySessionId: 'session-1',
                },
            });
        });

        expect(routerPushMock).toHaveBeenCalledWith('/inbox');
    });

    it('uses the latest shared tap target for overlay interactions after mount', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        expect(listenDesktopActivityOverlayInteractionMock).toHaveBeenCalledTimes(1);

        localSettingsState.value = {
            ...localSettingsState.value,
            activitySurfaceTapTarget: 'open_sessions',
        };

        await act(async () => {
            await screen.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls.at(-1)?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: ' ',
                data: {
                    primarySessionId: 'session-1',
                },
            });
        });

        expect(routerPushMock).toHaveBeenCalledWith('/inbox');
    });

    it('validates direct actions against the latest selected session server scope after mount', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const screen = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));
        const now = Date.now();

        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-2',
                createdAt: 1,
                updatedAt: now,
                seq: 5,
                lastViewedSessionSeq: 2,
                active: true,
                activeAt: now - 50,
                archivedAt: null,
                presence: 'online',
                thinking: false,
                thinkingAt: null,
                latestTurnStatus: null,
                latestTurnStatusObservedAt: null,
                meaningfulActivityAt: now,
                lastRuntimeIssue: null,
                lastTurnCompletedAt: null,
                pendingVersion: 1,
                pendingCount: 1,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                pendingRequestObservedAt: now - 50,
                agentStateVersion: 1,
                agentState: {
                    controlledByUser: null,
                    requests: {
                        'permission-1': {
                            tool: 'Bash',
                            kind: 'permission',
                            arguments: {},
                            createdAt: now - 50,
                        },
                    },
                },
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 2 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];
        syncCanonicalSessionListState();
        sessionListIndexState.value = {
            'server-2': [
                {
                    type: 'session',
                    sessionId: 'session-1',
                    serverId: 'server-2',
                },
            ],
        };

        await act(async () => {
            await screen.update(React.createElement(DesktopActivityOverlayRuntime));
        });

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls.at(-1)?.[0] as
            | ((payload: { requestId?: string; actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                requestId: 'quick-reply-request-2',
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverId: 'server-2',
                    message: 'Continue',
                },
            });
            await Promise.resolve();
        });

        expect(actionExecutorExecuteMock).toHaveBeenCalledWith(
            'session.message.send',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'Continue',
            }),
            expect.objectContaining({
                surface: 'ui',
                defaultSessionId: 'session-1',
                serverId: 'server-2',
            }),
        );
        expect(actionExecutorExecuteMock.mock.calls[0]?.[1]).not.toHaveProperty('serverId');
        expect(routerPushMock).not.toHaveBeenCalled();
    });

    it('auto-collapses the overlay after the configured auto-hide delay', async () => {
        vi.useFakeTimers();
        sessionsState.value = sessionsState.value.map((session) => ({
            ...session,
            seq: 4,
            lastViewedSessionSeq: 4,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingRequestObservedAt: null,
            agentState: null,
        }));
        syncCanonicalSessionListState();
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayVisibilityMode: 'active_sessions',
            desktopOverlayAutoHideEnabled: true,
            desktopOverlayAutoHideDelayMs: 1200,
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-set-expanded',
                data: { expanded: true },
            });
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(true);
        expect(syncDesktopActivityOverlayMock).toHaveBeenLastCalledWith(expect.objectContaining({
            visible: true,
            expanded: true,
        }));

        await act(async () => {
            await Promise.resolve();
            await vi.runOnlyPendingTimersAsync();
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('pauses runtime auto-collapse while the overlay window reports input locked', async () => {
        vi.useFakeTimers();
        sessionsState.value = sessionsState.value.map((session) => ({
            ...session,
            seq: 4,
            lastViewedSessionSeq: 4,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingRequestObservedAt: null,
            agentState: null,
        }));
        syncCanonicalSessionListState();
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayVisibilityMode: 'active_sessions',
            desktopOverlayAutoHideEnabled: true,
            desktopOverlayAutoHideDelayMs: 1200,
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));
        await waitForHomeGovernance(() => expect(syncDesktopActivityOverlayMock.mock.calls.at(-1)?.[0])
            .toMatchObject({ visible: true }));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-set-expanded',
                data: { expanded: true },
            });
            handler?.({
                actionIdentifier: 'overlay-input-locked',
                data: { locked: true },
            });
            await vi.advanceTimersByTimeAsync(1500);
        });

        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalledWith(false);

        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-input-locked',
                data: { locked: false },
            });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1200);
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('pauses runtime auto-collapse while the expanded surface reports pointer engagement', async () => {
        vi.useFakeTimers();
        sessionsState.value = sessionsState.value.map((session) => ({
            ...session,
            seq: 4,
            lastViewedSessionSeq: 4,
            pendingCount: 0,
            pendingPermissionRequestCount: 0,
            pendingRequestObservedAt: null,
            agentState: null,
        }));
        syncCanonicalSessionListState();
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayVisibilityMode: 'active_sessions',
            desktopOverlayAutoHideEnabled: true,
            desktopOverlayAutoHideDelayMs: 1200,
        };

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-set-expanded',
                data: { expanded: true },
            });
        });
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-surface-engaged',
                data: { engaged: true },
            });
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
        });

        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalledWith(false);

        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-surface-engaged',
                data: { engaged: false },
            });
        });
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1200);
        });

        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('pauses runtime auto-collapse while blocking action cards are visible', async () => {
        vi.useFakeTimers();
        localSettingsState.value = {
            ...localSettingsState.value,
            desktopOverlayAutoHideEnabled: true,
            desktopOverlayAutoHideDelayMs: 1200,
        };
        sessionsState.value = [
            {
                id: 'session-1',
                serverId: 'server-1',
                seq: 4,
                lastViewedSessionSeq: 2,
                active: true,
                presence: 'online',
                thinking: false,
                pendingPermissionRequestCount: 1,
                pendingUserActionRequestCount: 0,
                agentState: {
                    requests: {
                        'permission-1': {
                            tool: 'Bash',
                            arguments: {
                                command: 'npm test',
                            },
                            createdAt: 100,
                        },
                    },
                },
                metadata: {
                    summary: { text: 'Primary session', updatedAt: 1 },
                    path: '/Users/tester/project',
                    host: 'tester.local',
                    homeDir: '/Users/tester',
                },
            },
        ];
        syncCanonicalSessionListState();

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'overlay-set-expanded',
                data: { expanded: true },
            });
        });
        await act(async () => {
            await Promise.resolve();
        });
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1500);
        });

        expect(setDesktopActivityOverlayExpandedMock).not.toHaveBeenCalledWith(false);
    });

    it('opens the session instead of executing a direct action when the payload carries an unsafe server URL', async () => {
        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        const handler = listenDesktopActivityOverlayInteractionMock.mock.calls[0]?.[0] as
            | ((payload: { actionIdentifier: string; data?: Record<string, unknown> }) => void)
            | undefined;

        expect(handler).toBeTypeOf('function');

        await act(async () => {
            handler?.({
                actionIdentifier: 'session.message.send',
                data: {
                    sessionId: 'session-1',
                    serverUrl: 'http://localhost:3000',
                    message: 'Continue',
                },
            });
        });

        expect(actionExecutorExecuteMock).not.toHaveBeenCalled();
        expect(showDesktopMainWindowMock).toHaveBeenCalledTimes(1);
        expect(routerPushMock).toHaveBeenCalledWith('/session/session-1?serverId=server-1');
        expect(setDesktopActivityOverlayExpandedMock).toHaveBeenCalledWith(false);
    });

    it('disposes a late-resolving interaction listener when runtime unmounts before subscription resolves', async () => {
        let resolveSubscription: (dispose: () => void) => void = () => {
            throw new Error('Expected deferred interaction subscription to capture its resolver.');
        };
        let capturedResolver = false;
        const deferredSubscription = new Promise<() => void>((resolve) => {
            resolveSubscription = resolve;
            capturedResolver = true;
        });
        const disposeMock = vi.fn();
        listenDesktopActivityOverlayInteractionMock.mockImplementation(
            () => deferredSubscription,
        );

        const { DesktopActivityOverlayRuntime } = await import('./DesktopActivityOverlayRuntime');
        const rendered = await renderScreen(React.createElement(DesktopActivityOverlayRuntime));

        await act(async () => {
            rendered.tree.unmount();
        });

        if (!capturedResolver) {
            throw new Error('Expected deferred interaction subscription to capture its resolver.');
        }

        resolveSubscription(disposeMock);

        await act(async () => {
            await Promise.resolve();
        });

        expect(disposeMock).toHaveBeenCalledTimes(1);
    });
});
