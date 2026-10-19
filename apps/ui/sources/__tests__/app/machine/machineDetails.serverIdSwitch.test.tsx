import 'fake-indexeddb/auto';
import React from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushHookEffects, renderScreen as renderTestScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { installBrowserStorageLockBoundary } from '@/dev/testkit/harness/browserStorageLockBoundary';

const route = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-keyboard-controller', () => ({ useFocusedInputHandler: () => {} }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => route.params }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

const { JSDOM } = await import('jsdom');
const browser = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://machine-switch-a.test' });
function installBrowserBoundary() {
    for (const name of ['window', 'document', 'HTMLElement', 'Node', 'MutationObserver', 'CustomEvent', 'navigator'] as const) {
        vi.stubGlobal(name, name === 'window' ? browser.window : browser.window[name]);
    }
}
installBrowserBoundary();
afterAll(() => browser.window.close());
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const rpcRequests = installSessionActionRpcBoundary(() => {
    throw Object.assign(new Error('Fixture daemon method is unavailable'), { code: 'RPC_METHOD_NOT_AVAILABLE' });
});
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { MachinePageScreen } = await import('@/components/machines/page/MachinePageScreen');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
const { ModalProvider } = await import('@/modal');
const { getStorage } = await import('@/sync/domains/state/storage');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/connectionManager');
const { sync } = await import('@/sync/sync');
const initialState = getStorage().getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let releaseLocks: (() => void) | undefined;
let serverA = '';
let serverB = '';
let serverC = '';
function machineRequests() { return homes.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v1/machines'); }

function AccountBoundary({ children }: React.PropsWithChildren) {
    if (!connection) throw new Error('Machine Account is not restored');
    return <InjectedAuthProvider credentials={connection.credentials}><ModalProvider><AppPaneProvider>{children}</AppPaneProvider></ModalProvider></InjectedAuthProvider>;
}
function renderScreen(element: React.ReactElement) {
    return renderTestScreen(element, { wrapper: AccountBoundary, createNodeMock: element => Object.assign(
        document.createElement(element.type === 'TextInput' ? 'textarea' : 'div'), {
            setNativeProps() {}, measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => callback(0, 0, 300, 100),
        }) });
}
beforeEach(async () => {
    installBrowserBoundary();
    releaseLocks = installBrowserStorageLockBoundary();
    await homes.reset();
    getStorage().setState(initialState, true);
    rpcRequests.length = 0;
    serverC = await homes.addHome({ name: 'Machine C', serverUrl: 'https://machine-switch-c.test', accountId: 'account-c', currentAccount: true, active: false });
    serverB = await homes.addHome({ name: 'Machine B', serverUrl: 'https://machine-switch-b.test', accountId: 'account-b', currentAccount: true, active: false });
    serverA = await homes.addHome({ name: 'Machine A', serverUrl: 'https://machine-switch-a.test', accountId: 'account-a', currentAccount: true });
    for (const [serverId, accountId] of [[serverA, 'account-a'], [serverB, 'account-b'], [serverC, 'account-c']]) {
        homes.answer(serverId, '/v1/machines', { body: [createPlainMachineRowFixture({ id: 'machine-1', accountId })] });
    }
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://machine-switch-a.test');
    if (!credentials) throw new Error('Machine Home credentials are missing');
    connection = await restoreServerAccountForTest({ serverUrl: 'https://machine-switch-a.test', accountId: 'account-a', credentials,
        additionalRequestOrigins: ['https://machine-switch-b.test', 'https://machine-switch-c.test'], request: homes.request });
    await sync.awaitBootstrapForegroundAcquisition();
    const machine = createMachineFixture({ activeAt: Date.now() });
    getStorage().setState({ machines: { [machine.id]: machine }, machineListByServerId: { [serverA]: [machine], [serverB]: [machine], [serverC]: [machine] } });
    route.params = { id: 'machine-1', serverId: serverB };
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose(); connection = undefined;
    await homes.reset();
    releaseLocks?.(); releaseLocks = undefined;
    getStorage().setState(initialState, true);
});

describe('MachineDetailScreen (serverId param switching)', () => {
    it('uses the hosted Machine destination scope instead of the unrelated Expo route', async () => {
        await renderScreen(<DestinationInstanceHost tabId="machine-tab"
            ref={{ kind: 'settings', params: { pageId: 'machines/machine-1', id: 'machine-1', serverId: serverC } }}
            pathname="/settings/machines/machine-1" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <MachinePageScreen />
        </DestinationInstanceHost>);
        await flushHookEffects({ cycles: 2, turns: 1 });
        await waitForHomeGovernance(() => expect(getAppliedActiveServerSnapshot()?.serverId).toBe(serverC));
        await waitForHomeGovernance(() => expect(machineRequests().some(request => request.serverId === serverC)).toBe(true));
        expect(getActiveServerSnapshot().serverId).toBe(serverC);
        expect(getAppliedActiveServerSnapshot()?.serverId).toBe(serverC);
        expect(machineRequests().some(request => request.serverId === serverC)).toBe(true);
        expect(machineRequests().filter(request => request.serverId === serverB)).toEqual([]);
    });
    it('switches active server when serverId param is provided and differs from current active server', async () => {
        // The external Home refuses the refresh; the real switch, Sync and fire-and-forget
        // owners must contain this failure rather than starting a bug-report RPC.
        homes.answer(serverB, '/v1/machines', { status: 503, body: { error: 'unavailable' } });
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        try {
            await renderScreen(<MachinePageScreen />);
            await flushHookEffects({ cycles: 2, turns: 1 });
            await waitForHomeGovernance(() => expect(getAppliedActiveServerSnapshot()?.serverId).toBe(serverB));
            await waitForHomeGovernance(() => expect(machineRequests().some(request => request.serverId === serverB)).toBe(true));
            expect(getActiveServerSnapshot().serverId).toBe(serverB);
            expect(getAppliedActiveServerSnapshot()?.serverId).toBe(serverB);
            expect(machineRequests().some(request => request.serverId === serverB)).toBe(true);
            expect(rpcRequests.filter(request => /diagnostic|bug.?report/i.test(request.method))).toEqual([]);
            expect(unhandled).not.toHaveBeenCalled();
        } finally {
            process.removeListener('unhandledRejection', unhandled);
        }
    });
});
