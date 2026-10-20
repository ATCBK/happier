import * as React from 'react';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRootLayoutFeaturesResponse, flushHookEffects, pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createAccountTokenForTests } from '@/dev/testkit/harness/homeGovernanceHarness';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

const reloadAppMock = vi.hoisted(() => vi.fn(async () => {}));
const checkForUpdatesMock = vi.hoisted(() => vi.fn(async () => ({ isAvailable: false })));
const expoUpdatesState = vi.hoisted(() => ({
    isUpdateAvailable: false,
    isUpdatePending: false,
    downloadProgress: undefined as number | undefined,
    lastCheckForUpdateTimeSinceRestart: undefined as Date | undefined,
}));

afterEach(() => {
    standardCleanup();
    reloadAppMock.mockReset();
    checkForUpdatesMock.mockReset();
    checkForUpdatesMock.mockResolvedValue({ isAvailable: false });
    storage.setState(initialStorageState, true);
    vi.unstubAllGlobals();
});

vi.mock('react-native', async () => {
    const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeNativeMock({ platformOS: 'ios' });
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
    default: { expoConfig: { version: '1.2.3' }, deviceName: 'test-device' },
}));

vi.mock('expo-application', () => ({
    nativeApplicationVersion: '1.2.0', nativeBuildVersion: '101', applicationId: 'dev.happier.app',
}));

vi.mock('expo-updates', async () => {
    const base = (await import('@/dev/testkit/mocks/expoUpdates')).createExpoUpdatesMock();
    return {
        ...base,
        channel: 'preview', updateId: 'update-123', runtimeVersion: '18',
        createdAt: new Date('2026-04-06T12:34:56.000Z'),
        useUpdates: () => ({ ...base.useUpdates(), currentlyRunning: { isEmbeddedLaunch: true }, ...expoUpdatesState }),
        checkForUpdateAsync: checkForUpdatesMock,
        reloadAsync: reloadAppMock,
    };
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

const network = await installSessionOpsNetworkBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { SystemStatusView } = await import('./SystemStatusView');
const initialStorageState = storage.getState();

beforeEach(async () => {
    network.resetRequests();
    network.setHttpResponder(async input => {
        const path = new URL(String(input)).pathname;
        return path === '/v1/features' || path === '/v1/features/authenticated'
            ? Response.json(createRootLayoutFeaturesResponse()) : null;
    });
    const home = await network.addHome('http://example.local', 'prof_1', {
        credentials: { token: createAccountTokenForTests('prof_1', { currentAccount: true }) },
    });
    const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
    await setActiveServerId(home.id);
    const state = storage.getState();
    state.applyProfile({ ...profileDefaults, id: 'prof_1', username: 'u1' });
    state.applyReady();
    state.setSocketStatus('connected');
    state.setEndpointConnectivity({ status: 'online', reason: null, attempt: 1, nextRetryAt: null,
        lastConnectedAt: null, lastDisconnectedAt: null, lastErrorMessage: null });
    state.applyMachines([], true, { sourceServerId: home.id });
});
afterAll(async () => { await network.dispose(); });

describe('SystemStatusView OTA section', () => {
    it('is diagnostics only: it reports the OTA state and sends the person to the one Updates entry (plan R13 (e))', async () => {
        vi.stubGlobal('__DEV__', false);
        storage.getState().applyNativeUpdateStatus({ available: true, updateUrl: 'https://example.test/update' });
        Object.assign(expoUpdatesState, {
            isUpdateAvailable: true,
            isUpdatePending: true,
            downloadProgress: 1,
            lastCheckForUpdateTimeSinceRestart: new Date('2026-04-07T09:00:00.000Z'),
        });

        const screen = await renderScreen(<SystemStatusView />);
        await flushHookEffects({ cycles: 10 });

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
        vi.stubGlobal('__DEV__', true);
        storage.getState().applyNativeUpdateStatus(null);
        Object.assign(expoUpdatesState, {
            isUpdateAvailable: false,
            isUpdatePending: false,
            downloadProgress: undefined,
            lastCheckForUpdateTimeSinceRestart: undefined,
        });

        const screen = await renderScreen(<SystemStatusView />);
        await flushHookEffects({ cycles: 10 });

        expect(screen.findAllByProps({ title: 'updateBanner.checkNowTitle' })).toHaveLength(0);
        expect(screen.findAllByProps({ title: 'updateBanner.lastCheckedTitle' })).toHaveLength(0);
    });
});
