import * as React from 'react';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const setClipboardStringSafeMock = vi.hoisted(() => vi.fn(async () => true));
const modalAlertMock = vi.hoisted(() => vi.fn());
const homeTransportDiagnostics = vi.hoisted(() => [{
    homeServerIdentityId: 'home_1',
    state: 'connected' as const,
    current: { carrier: 'iroh' as const, observedPath: 'direct' as const },
    lastKnown: { carrier: 'iroh' as const, observedPath: 'direct' as const },
    lastTransitionAtMs: 1_788_200_000_000,
}]);
const socketState = vi.hoisted(() => ({
    lastError: 'authorization=copy-me-never',
}));

afterEach(() => {
    standardCleanup();
    setClipboardStringSafeMock.mockReset();
    setClipboardStringSafeMock.mockResolvedValue(true);
    modalAlertMock.mockReset();
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
        translate: (key: string, params?: Record<string, unknown>) => (
            params ? `${key}:${JSON.stringify(params)}` : key
        ),
        translateLoose: (key: string) => key,
    });
});

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: { alert: modalAlertMock },
    }).module;
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' }, deviceName: 'test-device' },
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: setClipboardStringSafeMock,
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

vi.mock('@/sync/runtime/irohHomeTransportDiagnostics', () => ({
    retireIrohHomeTransportDiagnostics: vi.fn(),
    readIrohHomeTransportDiagnostics: () => homeTransportDiagnostics,
    readIrohHomeTransportDiagnosticsRevision: () => 0,
    isIrohHomeTransportDiagnosticsCurrent: (diagnostics: { state?: unknown; current?: unknown } | null | undefined) => (
        diagnostics?.state === 'connected' && diagnostics.current !== undefined
    ),
    subscribeIrohHomeTransportDiagnostics: () => () => {},
}));

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

vi.mock('./OtaUpdateStatusSection', () => ({
    OtaUpdateStatusSection: () => null,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useProfile: () => ({ id: 'prof_1', username: 'u1', connectedServices: [] }),
        useIsDataReady: () => true,
        useRealtimeStatus: () => 'connected',
        useSocketStatus: () => ({ status: 'connected', lastError: socketState.lastError, lastErrorAt: 1_788_200_000_000 }),
        useEndpointConnectivity: () => ({
            status: 'online',
            reason: null,
            attempt: 1,
            nextRetryAt: null,
            lastConnectedAt: null,
            lastDisconnectedAt: null,
            lastErrorMessage: null,
        }),
        useSyncError: () => null,
        useLastSyncAt: () => null,
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

describe('SystemStatusView app runtime info', () => {
    it('shows app runtime details and copies OTA runtime metadata into the system-status JSON payload', async () => {
        const { SystemStatusView } = await import('./SystemStatusView');
        const screen = await renderScreen(<SystemStatusView />);

        const text = screen.getTextContent();
        expect(text).toContain('bugReports.composer.environment.appVersionLabel');
        expect(text).toContain('1.2.3');
        expect(text).toContain('settingsAgents.releaseChannelTitle');
        expect(text).toContain('preview');
        expect(text).not.toContain('copy-me-never');
        expect(text).toContain('[redacted]');
        // Connection state reads as a word from the status vocabulary, never the raw enum.
        expect(text).toContain('status.connected');

        const copyRow = screen.find((node) => (
            node.props?.title === 'systemStatus.actions.copyJson' &&
            typeof node.props?.onPress === 'function'
        ));
        await pressTestInstanceAsync(copyRow, 'copy system status JSON');

        expect(setClipboardStringSafeMock).toHaveBeenCalledTimes(1);
        expect(modalAlertMock).not.toHaveBeenCalled();

        const clipboardCalls = setClipboardStringSafeMock.mock.calls as unknown as Array<Array<string>>;
        const clipboardPayload = clipboardCalls[0]?.[0];
        const payload = JSON.parse(String(clipboardPayload ?? '{}'));
        expect(payload.environment).toMatchObject({
            appVersion: '1.2.3',
            nativeApplicationVersion: '1.2.0',
            nativeBuildVersion: '101',
            applicationId: 'dev.happier.app',
            updates: {
                channel: 'preview',
                updateId: 'update-123',
                runtimeVersion: '18',
                createdAt: '2026-04-06T12:34:56.000Z',
                launchSource: 'ota',
            },
        });
        expect(payload.homeTransports).toEqual(homeTransportDiagnostics);
        expect(payload.ui.socketLastError).not.toContain('copy-me-never');
        expect(payload.ui.socketLastError).toContain('[redacted]');
    });
});
