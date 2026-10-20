import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const routes = createExpoRouterMock();
vi.mock('expo-router', () => routes.module);
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
// Native UI and locale are environment boundaries. Account authority and the
// collection/controller run through their real providers below.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();
const { AuthProvider } = await import('@/auth/context/AuthContext');
// The native profile store and its readers share one module lifetime. Replacing
// the module graph per case also detaches the transport installed above.
const { HomesDeviceScreen } = await import('./HomesDeviceScreen');
const { HomesCollectionProvider } = await import('./HomesCollection');

beforeEach(async () => {
    await home.reset();
    routes.resetParams();
    for (const id of ['home-a', 'home-b', 'home-c']) {
        await home.addHome({ name: id, serverUrl: `https://${id}.example.test`, accountId: null, active: id === 'home-a' });
    }
});

afterEach(async () => {
    standardCleanup();
    await home.reset();
});

async function renderDevice() {
    return renderScreen(<AuthProvider initialCredentials={null}>
        <HomesCollectionProvider><HomesDeviceScreen /></HomesCollectionProvider>
    </AuthProvider>);
}

describe('Homes on this device', () => {
    it('does not expose desktop runtime operations on the browser', async () => {
        const screen = await renderDevice();
        expect(screen.findByTestId('settings.localRelayRuntime.status')).toBeNull();
        expect(screen.findByTestId('settings.localTailscale.status')).toBeNull();
        expect(screen.findByTestId('settings.server.personalHomeConsole')).toBeNull();
    });

    it('keeps connection details behind the device disclosure', async () => {
        const screen = await renderDevice();
        expect(screen.findByTestId('connection-status-full-screen')).toBeNull();
        await screen.pressByTestIdAsync('settings.server.connectionDetails.header');
        expect(screen.findByTestId('connection-status-full-screen')).not.toBeNull();
        await screen.pressByTestIdAsync('settings.server.connectionDetails.header');
        expect(screen.findByTestId('connection-status-full-screen')).toBeNull();
    });
});
