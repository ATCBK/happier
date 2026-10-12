import React from 'react';
// Web drafts persist to IndexedDB, the browser storage boundary; the fake keeps the real repository path.
import 'fake-indexeddb/auto';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { installMachineDetailsCommonModuleMocks } from './machineDetailsTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

function createMachineRecord() {
    return {
    id: 'machine-1',
    active: true,
    activeAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    seq: 0,
    metadata: { displayName: 'My Machine', host: 'host', platform: 'darwin', homeDir: '/Users/test', happyCliVersion: '0.0.0-test', happyHomeDir: '/Users/test/.happy-dev' },
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 0,
    revokedAt: null,
    };
}

const mockState = vi.hoisted(() => ({
    activeServerIdRef: { current: 'server-a' },
    itemSpy: vi.fn(),
    machinesState: { 'machine-1': createMachineRecord() } as Record<string, unknown>,
    machineTargetSessionsState: {} as Record<string, unknown>,
    machineControlTargetBySession: {} as Record<string, { machineId: string; basePath: string }>,
    modalAlertSpy: vi.fn(),
    navigateToSessionSpy: vi.fn(),
    routerBackSpy: vi.fn(),
    routerPushSpy: vi.fn(),
    shouldContinueRef: { current: true },
    multiTextInputSpy: vi.fn(),
    machineSpawnNewSessionMock: vi.fn(async (_params: unknown) => ({ type: 'error', errorCode: 'unexpected', errorMessage: 'noop' })),
    sessionSpawnNewActionMock: vi.fn<(input: unknown, context: unknown) => Promise<unknown>>(async (_input, _context) => ({
        ok: true as const,
        result: {
            type: 'success' as const,
            disposition: 'created' as const,
            sessionId: 'session-new',
            executionTarget: { serverId: 'server-a', machineId: 'machine-1' },
            organizationPlacement: { folderId: null, tagIds: [] },
            initialInput: { status: 'notRequested' as const },
        },
    })),
    openMachinePathBrowserModalMock: vi.fn<(params: unknown) => Promise<string | null>>(async () => '/Users/test/project'),
    projectForSession: {} as Record<string, { key?: { machineId?: string; rootPath?: string } } | null>,
    routeParamsRef: { current: { id: 'machine-1' } as Record<string, string> },
    settingsState: {} as Record<string, unknown>,
    sessionsState: [] as Array<unknown>,
}));
type MachineContributionRegistryProjectionDescribeFn =
    typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;
const {
    machineContributionRegistryProjectionDescribe,
} = vi.hoisted(() => ({
    machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
        async () => ({ supported: false, reason: 'not-supported' }),
    ),
}));

installMachineDetailsCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: { alert: mockState.modalAlertSpy },
        }).module;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: mockState.routerBackSpy, push: mockState.routerPushSpy, replace: vi.fn() },
            params: () => mockState.routeParamsRef.current,
        }).module;
    },
    storage: async (importOriginal) => importOriginal(),
});

// Configure platform boundaries before loading the real store/hooks graph.
vi.doUnmock('@/sync/domains/state/storage');
const { storage } = await import('@/sync/domains/state/storageStore');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        mockState.itemSpy(props);
        return React.createElement('Item', props);
    },
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/lists/ItemGroupTitleWithAction', () => ({ ItemGroupTitleWithAction: () => null }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: React.forwardRef((props: any, _ref) => {
        mockState.multiTextInputSpy(props);
        return React.createElement('MultiTextInput', props);
    }),
}));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: () => null }));
vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({ InstallableDepInstaller: () => null }));
vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({ ExecutionRunRow: () => null }));
vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
    PathInputBrowseButton: (props: any) => React.createElement('PathInputBrowseButton', {
        testID: props.testID ?? 'path-browser-trigger',
        onPress: props.onPress,
        disabled: props.disabled,
    }),
}));
vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: (params: unknown) => mockState.openMachinePathBrowserModalMock(params),
}));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: (...args: Parameters<typeof mockState.machineSpawnNewSessionMock>) => mockState.machineSpawnNewSessionMock(...args),
    machineStopDaemon: vi.fn(async () => ({ message: 'noop' })),
    machineStopSession: vi.fn(async () => ({ ok: true })),
    machineUpdateMetadata: vi.fn(async () => ({})),
    machineExecutionRunsList: vi.fn(async () => ({ ok: true, runs: [] })),
    machineRevokeFromAccount: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>(),
    createFrontDoorActionExecute: () => async (_actionId: unknown, input: unknown, context: unknown) =>
        mockState.sessionSpawnNewActionMock(input, context),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
        machineContributionRegistryProjectionDescribe(...args),
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSettingsGet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSettingsSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    resetMachineProjectionReadsForTests: () => {},
}));

vi.mock('@/sync/ops/sessionExecutionRuns', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/ops/sessionExecutionRuns')>(),
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => mockState.navigateToSessionSpy }));
vi.mock('@/hooks/ui/useMountedShouldContinue', () => ({
    useMountedShouldContinue: () => () => mockState.shouldContinueRef.current,
}));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({ useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }) }));
vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => String(left ?? '').trim() === String(right ?? '').trim(),
    getActiveServerId: () => mockState.activeServerIdRef.current,
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({ setActiveServerAndSwitch: vi.fn(async () => true) }));
vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(),
        refreshMachines: vi.fn(),
        retryNow: vi.fn(),
        acquireUserRequestLease: vi.fn(() => vi.fn()),
    },
}));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>, options?: { onError?: (error: unknown) => void }) => {
        void promise.catch((error) => {
            options?.onError?.(error);
        });
    },
}));
vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForRpcError: () => false,
    tryShowDaemonUnavailableAlertForRpcFailure: () => false,
}));
vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessions/sessionUtils', async () => {
    const actual = await vi.importActual<any>('@/utils/sessions/sessionUtils');
    return {
        ...actual,
        getSessionName: () => '',
        getSessionSubtitle: () => '',
    };
});
vi.mock('@/utils/path/pathUtils', () => ({
    resolveAbsolutePath: (value: string, homeDir: string) => {
        const trimmed = value.trim();
        if (!trimmed) return '';
        if (trimmed === '~') return homeDir;
        if (trimmed.startsWith('~/')) return `${homeDir}/${trimmed.slice(2)}`;
        if (trimmed.startsWith('/')) return trimmed;
        return `${homeDir}/${trimmed}`;
    },
}));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({ resolveWindowsRemoteSessionConsoleFromMachineMetadata: () => 'visible' }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode', () => ({
    readMachineWindowsRemoteSessionLaunchMode: () => undefined,
    resolveEffectiveWindowsRemoteSessionLaunchMode: () => ({ mode: 'visible' }),
}));
vi.mock('@/capabilities/installablesRegistry', () => ({ getInstallablesRegistryEntries: () => [] }));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions', () => ({
    WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS: [],
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: (sessionId: string) => {
        const controlTarget = mockState.machineControlTargetBySession[sessionId];
        if (controlTarget) return controlTarget;
        const project = mockState.projectForSession[sessionId];
        return project?.key == null
            ? null
            : {
                machineId: project.key.machineId ?? null,
                basePath: project.key.rootPath ?? null,
            };
    },
    readMachineControlTargetForSession: (sessionId: string) => {
        const controlTarget = mockState.machineControlTargetBySession[sessionId];
        if (controlTarget) return { ...controlTarget, confidence: 'reachable' };
        const project = mockState.projectForSession[sessionId];
        return project?.key == null
            ? null
            : {
                machineId: project.key.machineId ?? null,
                basePath: project.key.rootPath ?? null,
                confidence: 'reachable',
            };
    },
    readDisplayMachineIdForSession: ({ sessionId, metadata }: { sessionId: string; metadata?: any }) => {
        const project = mockState.projectForSession[sessionId];
        return project?.key?.machineId ?? metadata?.machineId ?? null;
    },
    readDisplayPathForSession: ({ sessionId, metadata }: { sessionId: string; metadata?: any }) => {
        const project = mockState.projectForSession[sessionId];
        return project?.key?.rootPath ?? metadata?.path ?? '';
    },
}));

describe('MachineDetailScreen start a session', () => {
    beforeEach(async () => {
        mockState.activeServerIdRef.current = 'server-a';
        mockState.routerBackSpy.mockReset();
        mockState.routerPushSpy.mockReset();
        mockState.multiTextInputSpy.mockClear();
        mockState.openMachinePathBrowserModalMock.mockClear();
        mockState.sessionSpawnNewActionMock.mockClear();
        mockState.routeParamsRef.current = { id: 'machine-1' };
        mockState.sessionsState = [];
        mockState.machinesState = { 'machine-1': createMachineRecord() };
        mockState.projectForSession = {};
        mockState.settingsState = {};
        storage.setState(storage.getInitialState(), true);
        await upsertAndActivateServer({ serverUrl: 'https://server-a', scope: 'tab' });
        await storage.getState().activateSettingsScope({ serverId: 'server-a', accountId: 'account-a' });
        storage.getState().applySettings(settingsDefaults, (storage.getState().settingsVersion ?? 0) + 1);
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', metadata: createMachineRecord().metadata })], true);
        expect(storage.getState().machines['machine-1']).toBeTruthy();
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
    });

    it('shows the inherited effective host without implying that override-off disables hosting', async () => {
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        mockState.settingsState = { ...settingsDefaults, sessionTerminalHost: 'herdr' };
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().applySettings({ ...settingsDefaults, sessionTerminalHost: 'herdr' }, (storage.getState().settingsVersion ?? 0) + 1);
        mockState.routeParamsRef.current = { id: 'machine-1', page: 'terminal' };
        const { MachineSubPageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const screen = await renderScreen(<AppPaneProvider><MachineDetailScreen /></AppPaneProvider>);
        expect(screen.findByTestId('machine-terminal-effective-host')?.props.subtitle).toBe('Herdr');
    });

    it('keeps the Windows launch override on the Terminal page of a Windows machine, and only there', async () => {
        const record = createMachineRecord();
        const windowsMetadata = { ...record.metadata, platform: 'win32' };
        mockState.machinesState = { 'machine-1': { ...record, metadata: windowsMetadata } };
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', metadata: windowsMetadata })], true);
        mockState.routeParamsRef.current = { id: 'machine-1', page: 'terminal' };
        const { MachineSubPageScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const screen = await renderScreen(<AppPaneProvider><MachineSubPageScreen /></AppPaneProvider>);
        expect(screen.findAll((node) => node.props?.title === 'machine.windows.remoteSessionModeOverrideTitle').length).toBeGreaterThan(0);

        mockState.routeParamsRef.current = { id: 'machine-1' };
        const { MachinePageScreen } = await import('@/components/machines/page/MachinePageScreen');
        const overview = await renderScreen(<AppPaneProvider><MachinePageScreen /></AppPaneProvider>);
        expect(overview.findAll((node) => node.props?.title === 'machine.windows.remoteSessionModeOverrideTitle')).toHaveLength(0);
        expect(overview.findByTestId('machine-page-row-terminal')).toBeTruthy();
    });

    it('shows the retained host choice even after an older UI removes its legacy tmux record', async () => {
        const { settingsDefaults } = await import('@/sync/domains/settings/settings');
        mockState.settingsState = { ...settingsDefaults, sessionTerminalHostByMachineId: { 'machine-1': 'herdr' }, sessionTmuxByMachineId: {} };
        const { storage } = await import('@/sync/domains/state/storageStore');
        storage.getState().applySettings({ ...settingsDefaults, sessionTerminalHostByMachineId: { 'machine-1': 'herdr' }, sessionTmuxByMachineId: {} }, (storage.getState().settingsVersion ?? 0) + 1);
        expect(storage.getState().settings.sessionTerminalHostByMachineId['machine-1']).toBe('herdr');
        mockState.routeParamsRef.current = { id: 'machine-1', page: 'terminal' };
        const { MachineSubPageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachineSubPageScreen');
        const { SegmentedChoiceItem } = await import('@/components/ui/lists/SegmentedChoiceItem');
        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const screen = await renderScreen(<AppPaneProvider><MachineDetailScreen /></AppPaneProvider>);
        expect(screen.findAllByType(SegmentedChoiceItem).some((row) => row.props.value === 'herdr')).toBe(true);
    });

    it('opens the composer with this machine chosen on its Home, instead of a page-local path field', async () => {
        // The composer's path chip already lists this machine's recent paths once it is chosen
        // (`useNewSessionMachineRefreshState` → `getRecentPathsForMachine`), so the page only hands off.
        mockState.routeParamsRef.current = { id: 'machine-1', serverId: 'server-b' };
        const { MachinePageScreen: MachineDetailScreen } = await import('@/components/machines/page/MachinePageScreen');
        const { getStorage } = await import('@/sync/domains/state/storageStore');
        const { readNewSessionDraftFromRepository } = await import('@/components/sessions/composer/newSessionDraftRepositoryAdapter');
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        // App boot prepares draft storage before any screen can seed a draft.
        await prepareSessionDraftPersistenceStorage();
        const accountScope = { serverId: 'server-a', accountId: 'account-a' };
        await getStorage().getState().activateProfileScope(accountScope);
        // The connection owner publishes the applied Home (and its runtime) once connected; the Account
        // lifetime the composer hand-off captures exists only for that applied Home.
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
        publishAppliedActiveServerSnapshot({ ...getActiveServerSnapshot(), serverId: 'server-a' }, true);

        const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
        const screen = await renderScreen(<AppPaneProvider><MachineDetailScreen /></AppPaneProvider>);
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(mockState.multiTextInputSpy).not.toHaveBeenCalled();
        const start = screen.findAll((node) => node.props?.testID === 'machine-detail-start-session' && typeof node.props?.onPress === 'function')[0];
        expect(start).toBeTruthy();
        await act(async () => {
            await start!.props.onPress();
        });
        expect(getStorage().getState().profileScope).toEqual(accountScope);

        expect(mockState.sessionSpawnNewActionMock).not.toHaveBeenCalled();
        const route = mockState.routerPushSpy.mock.calls.at(-1)?.[0] as Readonly<{ pathname: string; params: Readonly<{ draftId: string }> }>;
        expect(route).toEqual({ pathname: '/new', params: { draftId: expect.any(String) } });
        expect(readNewSessionDraftFromRepository({ scope: accountScope, draftId: route.params.draftId })).toMatchObject({
            selectedMachineId: 'machine-1',
            targetServerId: 'server-b',
            executionTarget: { kind: 'machine', target: { serverId: 'server-b', machineId: 'machine-1' } },
        });
    });
});
