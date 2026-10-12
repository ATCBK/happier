import * as React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
installDisconnectedServerSocketBoundary();
vi.stubEnv('EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE', 'unavailable');
const modules = await (async () => {
    await loadSyncSingletonForTests();
    return Promise.all([
        import('@/auth/context/AuthContext'),
        import('./useServerSettingsScreenController'),
        import('@/sync/domains/server/serverProfiles'),
    ]);
})();
beforeEach(() => harness.reset());
afterEach(standardCleanup);
afterAll(() => vi.unstubAllEnvs());

describe('useServerSettingsScreenController', () => {
    it('does not reorder servers by lastUsedAt in server configuration list', async () => {
        const a = await harness.addHome({ name: 'A', serverUrl: 'https://a.example.test', accountId: null, active: false });
        const b = await harness.addHome({ name: 'B', serverUrl: 'https://b.example.test', accountId: null });
        const [{ InjectedAuthProvider }, { useServerSettingsScreenController }, { getServerProfileById }] = modules;
        expect(getServerProfileById(a)!.lastUsedAt).toBeLessThan(getServerProfileById(b)!.lastUsedAt);
        const hook = await renderHook(() => useServerSettingsScreenController(), {
            wrapper: ({ children }) => <InjectedAuthProvider credentials={null}>{children}</InjectedAuthProvider>,
        });

        expect(hook.getCurrent().servers.filter(server => server.id === a || server.id === b).map(server => server.id)).toEqual([a, b]);
    });
});
