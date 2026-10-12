import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const useUpdatesMock = vi.hoisted(() => vi.fn());
const useNativeUpdateMock = vi.hoisted(() => vi.fn());
const reloadAppMock = vi.hoisted(() => vi.fn(async () => {}));
const checkForUpdatesMock = vi.hoisted(() => vi.fn(async () => {}));

afterEach(() => {
    standardCleanup();
    useUpdatesMock.mockReset();
    useNativeUpdateMock.mockReset();
    reloadAppMock.mockReset();
    checkForUpdatesMock.mockReset();
});

vi.mock('react-native-mmkv', () => {
    class MMKV {
        #store = new Map<string, string>();

        public getString(key: string): string | undefined {
            return this.#store.get(key);
        }

        public set(key: string, value: string): void {
            this.#store.set(key, value);
        }

        public delete(key: string): void {
            this.#store.delete(key);
        }
    }

    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: vi.fn(), back: vi.fn(), replace: vi.fn(), setParams: vi.fn() } }).module;
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string) => key,
        translateLoose: (key: string) => key,
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' }, deviceName: 'test-device' },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/constants/Typography', () => ({
    FontWeights: {
        regular: '400',
        semiBold: '500',
        bold: '600',
    },
    Typography: new Proxy({}, {
        get: () => () => ({}),
    }),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
    useActiveServerSnapshot: () => ({ generation: 1, serverId: 'srv_1', serverUrl: 'http://example.local' }),
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => {
    const { createPartialServerProfilesModuleMock } = await import('@/dev/testkit/mocks/serverProfiles');
    return createPartialServerProfilesModuleMock(importOriginal, { profiles: [] });
});

vi.mock('@/sync/runtime/readCurrentAppRuntimeInfo', () => ({
    readCurrentAppRuntimeInfo: () => ({
        appVersion: '1.2.3',
        nativeApplicationVersion: '1.2.0',
        nativeBuildVersion: '101',
        applicationId: 'dev.happier.app',
        updateChannel: 'preview',
        updateId: 'update-123',
        runtimeVersion: '18',
        updateCreatedAt: '2026-04-06T12:34:56.000Z',
        launchSource: 'ota',
    }),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useProfile: () => ({ id: 'prof_1', username: 'u1', connectedServices: [] }),
        useIsDataReady: () => true,
        useRealtimeStatus: () => 'connected',
        useSocketStatus: () => ({ status: 'connected', lastError: null, lastErrorAt: null }),
        useLastSyncAt: () => null,
        // The active Home connection health reads these (another program's `useConnectionHealth` change).
        useEndpointConnectivity: () => ({ status: 'online', reason: null, attempt: 1, nextRetryAt: null, lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null }),
        useSyncError: () => null,
        useMachineListForServer: () => [],
        useMachineListStatusForServer: () => 'loaded',
        useMachineListByServerId: () => ({}),
        useMachineListStatusByServerId: () => ({}),
    });
});

vi.mock('@/utils/sessions/machineUtils', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/sessions/machineUtils')>(),
    isMachineOnline: () => false,
}));

vi.mock('@/hooks/inbox/useUpdates', () => ({
    useUpdates: () => useUpdatesMock(),
}));

vi.mock('@/hooks/ui/useNativeUpdate', () => ({
    useNativeUpdate: () => useNativeUpdateMock(),
}));

describe('SystemStatusView OTA section', () => {
    it('is diagnostics only: it reports the OTA state and sends the person to the one Updates entry (plan R13 (e))', async () => {
        useNativeUpdateMock.mockReturnValue('https://example.test/update');
        useUpdatesMock.mockReturnValue({
            otaUpdatesEnabled: true,
            otaRuntimeSupported: true,
            updateAvailable: true,
            isChecking: false,
            isDownloading: false,
            isRestarting: false,
            isUpdateAvailable: true,
            isUpdatePending: true,
            downloadProgress: 1,
            checkError: undefined,
            downloadError: undefined,
            lastCheckForUpdateTimeSinceRestart: new Date('2026-04-07T09:00:00.000Z'),
            checkForUpdates: checkForUpdatesMock,
            reloadApp: reloadAppMock,
            currentlyRunning: { isEmbeddedLaunch: true },
        });

        const { SystemStatusView } = await import('./SystemStatusView');
        const screen = await renderScreen(<SystemStatusView />);

        // No second place applies, checks or opens the store: those actions live in Settings › Updates.
        expect(screen.findAll((node) => (
            typeof node.props?.onPress === 'function'
            && (node.props?.title === 'updateBanner.updateAvailable' || node.props?.title === 'updateBanner.checkNowTitle' || node.props?.title === 'updateBanner.nativeUpdateAvailable')
        ))).toHaveLength(0);
        expect(screen.findAllByProps({ title: 'updateBanner.lastCheckedTitle' }).length).toBeGreaterThan(0);
        await pressTestInstanceAsync(screen.findByTestId('system-status-open-updates'), 'open Updates');
        const { router } = await import('expo-router');
        expect(router.push).toHaveBeenCalledWith('/settings/updates');
        expect(reloadAppMock).not.toHaveBeenCalled();
    });

    it('hides OTA action rows when OTA runtime support is unavailable', async () => {
        useNativeUpdateMock.mockReturnValue(null);
        useUpdatesMock.mockReturnValue({
            otaUpdatesEnabled: true,
            otaRuntimeSupported: false,
            updateAvailable: false,
            isChecking: false,
            isDownloading: false,
            isRestarting: false,
            isUpdateAvailable: false,
            isUpdatePending: false,
            downloadProgress: undefined,
            checkError: undefined,
            downloadError: undefined,
            lastCheckForUpdateTimeSinceRestart: undefined,
            checkForUpdates: checkForUpdatesMock,
            reloadApp: reloadAppMock,
            currentlyRunning: { isEmbeddedLaunch: true },
        });

        const { SystemStatusView } = await import('./SystemStatusView');
        const screen = await renderScreen(<SystemStatusView />);

        expect(screen.findAllByProps({ title: 'updateBanner.checkNowTitle' })).toHaveLength(0);
        expect(screen.findAllByProps({ title: 'updateBanner.lastCheckedTitle' })).toHaveLength(0);
    });
});
