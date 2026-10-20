import React from 'react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storageStore';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { profileDefaults } from '@/sync/domains/profiles/profile';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

beforeEach(async () => { await loadSyncSingletonForTests(); });
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import { createAccountFeaturesResponse } from './account.testHelpers';
import { installAccountSettingsRouteModuleMocks } from './accountSettingsRouteTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;


vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: {
        isModernBarcodeScannerAvailable: false,
        onModernBarcodeScanned: () => ({ remove: () => {} }),
        launchScanner: () => {},
        dismissScanner: async () => {},
    },
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        isAuthenticated: true,
        credentials: { token: 't', secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        logout: vi.fn(),
    }),
}));

const clipboardMocks = vi.hoisted(() => ({
    setStringAsync: vi.fn(async () => {}),
}));
vi.mock('expo-clipboard', () => clipboardMocks);

const modalMocks = vi.hoisted(() => ({
    show: vi.fn(),
    alert: vi.fn(),
    prompt: vi.fn(),
    confirm: vi.fn(),
}));

installAccountSettingsRouteModuleMocks({
    modalModule: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: modalMocks,
        }).module;
    },
});

describe('Settings → Account (secret key copy)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        standardCleanup();
    });

    it('keeps recovery disclosure out of the Account profile page', async () => {
        storage.getState().applyProfile({ ...profileDefaults, linkedProviders: [], username: null });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(createAccountFeaturesResponse())));
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AccountScreen />);
        expect(screen.findByTestId('settings-account-secret-key-item')).toBeNull();
        expect(screen.findByTestId('settings-account-secret-key-copy')).toBeNull();
        expect(screen.findByTestId('settings-account-logout')).toBeTruthy();
    });
});
