import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Socket } from 'socket.io-client';

import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    currentUiContextReadClientRpcMethod,
    UiActionDispatchRequestV1Schema,
    UiActionDispatchResultV1Schema,
} from '@happier-dev/protocol/actions/clientDispatchV1';
import { CurrentUiContextSnapshotV1Schema } from '@happier-dev/protocol/plugins/ui';
import { SystemTaskResultSchema, SystemTaskSpecSchema, type SystemTaskSpec } from '@happier-dev/protocol/system/tasks/spec';
import { socketRpcCodec } from '@happier-dev/sync-client';

const host = vi.hoisted(() => ({ platform: 'web', desktop: false }));
const nativeListeners = vi.hoisted(() => new Map<string, Set<(event: unknown) => void>>());

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
    Platform: {
        get OS() { return host.platform; },
        select: (options: Record<string, unknown>) => options[host.platform] ?? options.default,
    },
    useWindowDimensions: () => ({ width: 1280, height: 900, scale: 1, fontScale: 1 }),
}));
vi.mock('react-native-unistyles', async () =>
    (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () =>
    (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ pathname: '/', segments: [] }).module);
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('expo-file-system', async () =>
    (await import('@/dev/testkit/mocks/expoFileSystem')).createExpoFileSystemFileMock().module);
vi.mock('@tauri-apps/api/event', () => ({
    listen: async (event: string, listener: (event: unknown) => void) => {
        const listeners = nativeListeners.get(event) ?? new Set();
        nativeListeners.set(event, listeners);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
}));
vi.mock('@tauri-apps/api/core', async importOriginal => ({
    ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
    invoke: (command: string, args?: Record<string, unknown>) => invokeNative(command, args),
}));
vi.mock('expo-widgets', () => ({
    addUserInteractionListener: vi.fn(() => ({ remove: vi.fn() })),
}));
vi.mock('@react-native-masked-view/masked-view', () => ({ default: 'MaskedView', MaskedView: 'MaskedView' }));
vi.mock('react-native-view-shot', () => ({
    default: 'ViewShot', ViewShot: 'ViewShot', captureRef: vi.fn(async () => ''), releaseCapture: vi.fn(),
}));
vi.mock('expo-video', () => ({ Video: 'Video', VideoView: 'VideoView', useVideoPlayer: () => null }));
vi.mock('expo-blur', () => ({ BlurView: 'BlurView' }));

type HomeHarness = ReturnType<typeof import('@/dev/testkit/harness/homeGovernanceHarness').createHomeGovernanceHarness>;
type AccountConnection = Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').restoreServerAccountForTest>>;
type RuntimeProps = Readonly<{ isAuthenticated: boolean; isDesktopShell: boolean }>;
type NativeDaemonStatus = import('@/components/settings/machines/localControl/useLocalDaemonControl').LocalDaemonStatusData;

let homes: HomeHarness;
let connection: AccountConnection | undefined;
let syncBridge: Awaited<ReturnType<typeof import('@/dev/testkit/harness/syncSingletonLoader').loadSyncSingletonForTests>>;
let secureStorage: ReturnType<typeof import('@/dev/testkit/mocks/desktopSecureStorage').createDesktopSecureStorageBoundary>;
let owners: Awaited<ReturnType<typeof loadOwners>>;
let homeId = '';
const sockets: Socket[] = [];
const emissions: Array<Readonly<{ event: string; payload: unknown }>> = [];
const nativeCalls: Array<Readonly<{ command: string; args?: Record<string, unknown> }>> = [];
const nativeTasks = new Map<string, SystemTaskSpec>();
let nativeStatus: NativeDaemonStatus;
const homeUrl = 'https://runtime.example.test';
const accountId = 'account-runtime';

async function invokeNative(command: string, args?: Record<string, unknown>): Promise<unknown> {
    nativeCalls.push({ command, args });
    if (command === 'desktop_secure_storage_read' || command === 'desktop_secure_storage_write'
        || command === 'desktop_secure_storage_remove') return await secureStorage.invoke(command, args);
    if (command === 'start_system_task') {
        const spec = SystemTaskSpecSchema.parse(JSON.parse(String(args?.specJson)));
        const taskId = 'runtime-task-' + nativeTasks.size;
        nativeTasks.set(taskId, spec);
        return { taskId };
    }
    if (command === 'get_system_task_snapshot') {
        const taskId = String(args?.taskId);
        const spec = nativeTasks.get(taskId);
        if (!spec) throw new Error('Unknown native test task');
        return { events: [], result: SystemTaskResultSchema.parse({
            protocolVersion: 1, taskId, ok: true,
            data: spec.kind === 'daemon.service.status.v1' ? nativeStatus : {},
        }) };
    }
    // Other consumers use the same native command port for badge/overlay publication.
    return null;
}

beforeEach(async () => {
    host.platform = 'web';
    host.desktop = false;
    sockets.length = 0;
    emissions.length = 0;
    nativeCalls.length = 0;
    nativeTasks.clear();
    nativeListeners.clear();
    nativeStatus = { serviceInstalled: true, daemonRunning: true, needsAuth: false, machineId: null,
        daemonComparableKey: homeUrl, daemonAccountId: accountId, daemonMachineRegistered: true };
    secureStorage = (await import('@/dev/testkit/mocks/desktopSecureStorage')).createDesktopSecureStorageBoundary();
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.stubGlobal('__TAURI_INTERNALS__', { get invoke() { return host.desktop ? invokeNative : undefined; } });
    vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'tauri');
    // Remote release-note assets are an independent external HTTP boundary.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const { createHomeGovernanceHarness, installHomeGovernanceBoundaries } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { installDisconnectedServerSocketBoundary } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    homes = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries(homes);
    installDisconnectedServerSocketBoundary();
    syncBridge = await (await import('@/dev/testkit/harness/syncSingletonLoader')).loadSyncSingletonForTests();
    homeId = await homes.addHome({ name: 'Runtime Home', serverUrl: homeUrl,
        serverIdentityId: 'srv_authenticated_runtime', accountId });
    homes.answer(homeId, '/v1/kv/bulk', { body: { values: [] } });
    homes.answer(homeId, '/v1/account/activity/badge-snapshot', { body: { badgeCount: 0 } });
});

afterEach(async () => {
    (await import('@/dev/testkit')).standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes?.reset();
    syncBridge?.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
});

async function loadOwners() {
    const [runtime, auth, pane, tabs, currentUi, actionHost, attention, onboarding, release, desktop, ios, badge, notifications] = await Promise.all([
        import('./AuthenticatedAppRuntimeMounts'),
        import('@/auth/context/AuthContext'),
        import('@/components/appShell/providers/AppPaneModalProvider'),
        import('@/components/navigation/mobile/chrome/MainAppTabStateProvider'),
        import('@/components/appShell/currentUiContext/CurrentUiContextProvider'),
        import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort'),
        import('@/activity/attention/runtime/SessionAttentionReminderRuntime'),
        import('@/onboarding/showcase'),
        import('@/changelog/releaseNotes'),
        import('@/activity/adapters/desktop/runtime/DesktopActivityOverlayRuntime'),
        import('@/activity/adapters/ios/runtime/ActivitySurfacesRuntime'),
        import('@/activity/badges/ActivityBadgeRuntime'),
        import('@/activity/notifications/runtime/ActivityLocalNotificationRuntime'),
    ]);
    return { AuthenticatedAppRuntimeMounts: runtime.AuthenticatedAppRuntimeMounts,
        InjectedAuthProvider: auth.InjectedAuthProvider, AppPaneModalProvider: pane.AppPaneModalProvider,
        MainAppTabStateProvider: tabs.MainAppTabStateProvider, CurrentUiContextProvider: currentUi.CurrentUiContextProvider,
        CurrentUiContextActionHost: actionHost.CurrentUiContextActionHost,
        SessionAttentionReminderRuntime: attention.SessionAttentionReminderRuntime,
        OnboardingShowcaseAutoShowMount: onboarding.OnboardingShowcaseAutoShowMount,
        ReleaseNotesAutoShowMount: release.ReleaseNotesAutoShowMount,
        DesktopActivityOverlayRuntime: desktop.DesktopActivityOverlayRuntime,
        ActivitySurfacesRuntime: ios.ActivitySurfacesRuntime,
        ActivityBadgeRuntime: badge.ActivityBadgeRuntime,
        ActivityLocalNotificationRuntime: notifications.ActivityLocalNotificationRuntime };
}

// React Test Renderer exposes a simple memo's rendered function as its component type.
function renderedType(component: unknown): React.ElementType {
    return (typeof component === 'object' && component !== null && 'type' in component
        ? component.type : component) as React.ElementType;
}

function RuntimeComposition(props: RuntimeProps): React.ReactElement {
    return <owners.InjectedAuthProvider credentials={props.isAuthenticated ? connection!.credentials : null}>
        <owners.AppPaneModalProvider>
            <owners.MainAppTabStateProvider>
                <owners.CurrentUiContextProvider>
                    <owners.CurrentUiContextActionHost />
                    <owners.AuthenticatedAppRuntimeMounts {...props} />
                </owners.CurrentUiContextProvider>
            </owners.MainAppTabStateProvider>
        </owners.AppPaneModalProvider>
    </owners.InjectedAuthProvider>;
}

async function mount(props: RuntimeProps, machineIds: readonly string[] = []) {
    const { createPlainMachineRowFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    homes.answer(homeId, '/v1/machines', { body: machineIds.map(id => createPlainMachineRowFixture({ id, accountId })) });
    const { configureConnectedServerSocketBoundary, restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
    connection = await restoreServerAccountForTest({ serverUrl: homeUrl,
        serverIdentityId: 'srv_authenticated_runtime', accountId, request: homes.request,
        configureSocket: socket => {
            sockets.push(socket);
            configureConnectedServerSocketBoundary(socket);
            const emit = socket.emit.bind(socket);
            socket.emit = vi.fn<typeof socket.emit>((event, ...args) => {
                emissions.push({ event, payload: args[0] });
                return emit(event, ...args);
            });
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async event => event === SOCKET_RPC_EVENTS.CALL
                ? { ok: false, error: 'Method not available in native fixture', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }
                : { v: 1, ok: true, admittedSessionIds: [] });
        },
    });
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { storage } = await import('@/sync/domains/state/storage');
    await waitForHomeGovernance(() => {
        expect(storage.getState().profile?.id).toBe(accountId);
        for (const machineId of machineIds) {
            expect(storage.getState().machines[machineId]).toMatchObject({
                storageMode: 'plain', availability: { kind: 'available' },
                access: { resourceMode: 'plain', accessState: 'ready' },
            });
        }
    });
    owners = await loadOwners();
    const screen = await (await import('@/dev/testkit')).renderScreen(<RuntimeComposition {...props} />);
    return screen;
}

function emittedMethods(event: string): string[] {
    return emissions.filter(emission => emission.event === event).flatMap(({ payload }) =>
        payload && typeof payload === 'object' && 'method' in payload && typeof payload.method === 'string'
            ? [payload.method] : []);
}

async function waitForDaemonStatus() {
    const { getSystemTasksRunner } = await import('@/components/systemTasks/systemTasksRuntime');
    const { readLocalDaemonSharedState } = await import('@/components/settings/machines/localControl/localDaemonSharedState');
    const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
    const { flushHookEffects } = await import('@/dev/testkit');
    expect([...nativeTasks.values()].map(spec => spec.kind)).toContain('daemon.service.status.v1');
    for (const [taskId, spec] of nativeTasks) {
        if (spec.kind === 'daemon.service.status.v1') {
            expect(getSystemTasksRunner().getSnapshot(taskId)?.result?.ok).not.toBe(false);
        }
    }
    await waitForHomeGovernance(async () => {
        // Native subscription/snapshot promises settle after the initial render's act.
        // Commit the real hook's status projection before reading its dependent RPC registration.
        await flushHookEffects();
        expect(readLocalDaemonSharedState(getSystemTasksRunner()).status).toMatchObject(nativeStatus);
    });
}

describe('AuthenticatedAppRuntimeMounts', () => {
    it.each([
        { isDesktopShell: false, label: 'mobile' },
        { isDesktopShell: true, label: 'desktop' },
    ])('mounts the authenticated attention-reminder runtime for $label consumers', async ({ isDesktopShell }) => {
        host.desktop = isDesktopShell;
        const screen = await mount({ isAuthenticated: false, isDesktopShell });
        expect(screen.findAllByType(owners.SessionAttentionReminderRuntime)).toHaveLength(0);
        await screen.update(<RuntimeComposition isAuthenticated isDesktopShell={isDesktopShell} />);
        expect(screen.findAllByType(owners.SessionAttentionReminderRuntime)).toHaveLength(1);
    });

    it('mounts first-open onboarding before auth while keeping release notes authenticated-only', async () => {
        const screen = await mount({ isAuthenticated: false, isDesktopShell: false });
        expect(screen.findAllByType(owners.OnboardingShowcaseAutoShowMount)).toHaveLength(1);
        expect(screen.findAllByType(owners.ReleaseNotesAutoShowMount)).toHaveLength(0);
    });

    it('keeps runtime mount components stable across equivalent parent updates', async () => {
        const screen = await mount({ isAuthenticated: true, isDesktopShell: false });
        const retainedTypes = [owners.ActivityBadgeRuntime, owners.SessionAttentionReminderRuntime,
            owners.ActivityLocalNotificationRuntime, owners.OnboardingShowcaseAutoShowMount, owners.ReleaseNotesAutoShowMount];
        const retained = retainedTypes.map(type => screen.findByType(renderedType(type)));
        await screen.update(<RuntimeComposition isAuthenticated isDesktopShell={false} />);
        retainedTypes.forEach((type, index) =>
            expect(screen.findByType(renderedType(type))).toBe(retained[index]));
    });

    it('mounts desktop runtime components only for Tauri desktop hosts', async () => {
        host.desktop = true;
        const screen = await mount({ isAuthenticated: true, isDesktopShell: false });
        expect(screen.findAllByType(owners.DesktopActivityOverlayRuntime)).toHaveLength(0);
        await screen.update(<RuntimeComposition isAuthenticated isDesktopShell />);
        expect(screen.findAllByType(owners.DesktopActivityOverlayRuntime)).toHaveLength(1);
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        await waitForHomeGovernance(() =>
            expect(nativeCalls.some(call => call.command === 'desktop_activity_overlay_sync')).toBe(true));
    });

    it('installs browser recording reverse capture from the authenticated desktop runtime', async () => {
        host.desktop = true;
        const machineId = 'machine-desktop-recording';
        nativeStatus = { ...nativeStatus, machineId };
        const screen = await mount({ isAuthenticated: true, isDesktopShell: true }, [machineId]);
        await waitForDaemonStatus();
        const method = machineId + ':' + RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME;
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        await waitForHomeGovernance(() => expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER)).toContain(method));
        await screen.update(<RuntimeComposition isAuthenticated={false} isDesktopShell />);
        expect(emittedMethods(SOCKET_RPC_EVENTS.UNREGISTER)).toContain(method);
    });

    it('installs browser recording reverse capture only for the verified local desktop daemon machine', async () => {
        host.desktop = true;
        const localMachine = 'machine-local-desktop-recording';
        const remoteMachine = 'machine-remote-desktop-recording';
        nativeStatus = { ...nativeStatus, machineId: localMachine };
        await mount({ isAuthenticated: true, isDesktopShell: true }, [localMachine, remoteMachine]);
        await waitForDaemonStatus();
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        await waitForHomeGovernance(() => expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER))
            .toContain(localMachine + ':' + RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME));
        expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER))
            .not.toContain(remoteMachine + ':' + RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME);
    });

    it('does not install browser recording reverse capture when local daemon identity is not verified for the active server', async () => {
        host.desktop = true;
        const machineId = 'machine-local-desktop-recording';
        nativeStatus = { ...nativeStatus, machineId, daemonComparableKey: 'https://other-relay.example.test' };
        await mount({ isAuthenticated: true, isDesktopShell: true }, [machineId]);
        await waitForDaemonStatus();
        expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER))
            .not.toContain(machineId + ':' + RPC_METHODS.UI_BROWSER_RECORDING_CAPTURE_FRAME);
    });

    it('does not mount the iOS activity surface runtime on Android', async () => {
        host.platform = 'android';
        const screen = await mount({ isAuthenticated: true, isDesktopShell: false });
        expect(screen.findAllByType(owners.ActivitySurfacesRuntime)).toHaveLength(0);
    });

    it('serves current UI context over the registered reverse Action RPC and retires it when authentication ends', async () => {
        const machineId = 'machine-current-ui';
        const method = machineId + ':' + currentUiContextReadClientRpcMethod();
        const screen = await mount({ isAuthenticated: false, isDesktopShell: false }, [machineId]);
        expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER)).not.toContain(method);
        await screen.update(<RuntimeComposition isAuthenticated isDesktopShell={false} />);
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        await waitForHomeGovernance(() => expect(emittedMethods(SOCKET_RPC_EVENTS.REGISTER)).toContain(method));
        const socket = sockets.find(candidate => candidate.listeners(SOCKET_RPC_EVENTS.REQUEST).length > 0);
        const receive = socket?.listeners(SOCKET_RPC_EVENTS.REQUEST)[0];
        if (!socket || !receive) throw new Error('The restored Account has no inbound Socket SDK listener');
        const request = UiActionDispatchRequestV1Schema.parse({ v: 1, actionId: 'ui.current_context.read',
            input: {}, context: { surface: 'ui', authority: 'account_automation' } });
        const callId = '0123456789abcdef0123456789abcdef';
        const params = await socketRpcCodec.encodeParams({ mode: 'plain' }, request, { method, callId });
        const invoke = async () => {
            const ack = await new Promise<unknown>(resolve => { receive({ method, params }, resolve); });
            return await socketRpcCodec.decodeResult({ mode: 'plain' }, { ok: true, result: ack }, callId);
        };
        const result = UiActionDispatchResultV1Schema.parse(await invoke());
        expect(result.execution.ok).toBe(true);
        if (!result.execution.ok) throw new Error('The real reverse Action did not execute');
        const snapshot = CurrentUiContextSnapshotV1Schema.parse(result.execution.result);
        expect(snapshot.navigation).toEqual({ area: 'app', screen: 'tab.sessions', presentation: 'screen' });
        await screen.update(<RuntimeComposition isAuthenticated={false} isDesktopShell={false} />);
        expect(socket.connected).toBe(true);
        expect(emittedMethods(SOCKET_RPC_EVENTS.UNREGISTER)).toContain(method);
        expect(await invoke()).toMatchObject({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
    });
});
