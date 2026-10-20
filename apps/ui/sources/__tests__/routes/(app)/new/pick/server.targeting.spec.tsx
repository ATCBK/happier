import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ dispatch: vi.fn(), goBack: vi.fn(), replace: vi.fn(), back: vi.fn() }));
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
    params: {},
    navigation: { dispatch: navigation.dispatch, goBack: navigation.goBack, getState: () => ({ index: 1, routes: [
        { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'machine-1' } },
        { key: 'current-route', name: '(app)/new/pick/server', path: '/new/pick/server' },
    ] }) },
    router: { replace: navigation.replace, back: navigation.back, canGoBack: () => true },
}).module);

import { pressTestInstanceAsync, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { Item } = await import('@/components/ui/lists/Item');
const { default: Screen } = await import('@/app/(app)/new/pick/server');
const profiles = await import('@/sync/domains/server/serverProfiles');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
let homeA = '';
let homeB = '';
let homeC = '';

beforeEach(async () => {
    vi.clearAllMocks();
    browser = await installBrowserRuntimeForTests({ url: 'https://ui.fixture.test/new/pick/server' });
    await homes.reset();
    homeA = profiles.resolveServerProfileScopeIdForIdentifier(await homes.addHome({ name: 'Server A',
        serverUrl: 'https://stack-a.example.test', serverIdentityId: 'srv_target_a', accountId: 'account-a' }));
    homeB = profiles.resolveServerProfileScopeIdForIdentifier(await homes.addHome({ name: 'Server B',
        serverUrl: 'https://stack-b.example.test', serverIdentityId: 'srv_target_b', accountId: null, active: false }));
    homeC = profiles.resolveServerProfileScopeIdForIdentifier(await homes.addHome({ name: 'Server C',
        serverUrl: 'https://stack-c.example.test', serverIdentityId: 'srv_target_c', accountId: 'account-c', active: false }));
    connection = await restoreServerAccountForTest({ serverUrl: 'https://stack-a.example.test',
        serverIdentityId: 'srv_target_a', accountId: 'account-a', request: homes.request });
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    browser?.restore();
    browser = undefined;
});

async function group(serverIds: string[]) {
    await updateEffectiveHomeViewState(() => ({ version: 1,
        groups: [{ id: 'grp-dev', name: 'Dev Group', serverIds, presentation: 'grouped' }],
        activeTargetKind: 'group', activeTargetId: 'grp-dev',
    }), { scope: 'device' });
}
async function mount() {
    return renderScreen(<InjectedAuthProvider credentials={connection!.credentials}><Screen /></InjectedAuthProvider>);
}

describe('new-session server picker targeting', () => {
    it('shows only servers in the current active target selection (no groups)', async () => {
        await group([homeA, homeC]);
        const screen = await mount();
        expect(screen.findAllByType(Item).map(row => row.props.title)).toEqual(['Server A', 'Server C']);
    });
    it('selecting a server writes the spawnServerId param back to the previous route without mutating global target settings', async () => {
        await group([homeA, homeC]);
        const before = profiles.loadHomeViewState();
        const screen = await mount();
        const row = screen.findAllByType(Item).find(item => item.props.title === 'Server C');
        expect(row).toBeTruthy();
        await pressTestInstanceAsync(row);
        await vi.waitFor(() => expect(navigation.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_PARAMS',
            payload: { params: expect.objectContaining({ spawnServerId: homeC }) },
        })));
        expect(profiles.loadHomeViewState()).toEqual(before);
        expect(navigation.goBack).toHaveBeenCalledTimes(1);
        expect(navigation.back).not.toHaveBeenCalled();
    });
    it('routes a signed-out Home to its sign-in without changing global target settings or route params', async () => {
        await group([homeA, homeB]);
        const before = profiles.loadHomeViewState();
        const screen = await mount();
        const row = screen.findAllByType(Item).find(item => item.props.title === 'Server B');
        expect(row).toBeTruthy();
        await pressTestInstanceAsync(row);
        await vi.waitFor(() => expect(navigation.replace).toHaveBeenCalledTimes(1));
        expect(getActiveServerSnapshot().serverId).toBe(homeB);
        expect(navigation.dispatch).not.toHaveBeenCalled();
        expect(profiles.loadHomeViewState()).toEqual(before);
    });
});
