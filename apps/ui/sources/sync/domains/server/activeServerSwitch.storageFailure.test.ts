import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installTokenStorageWebPlatformMocks();
installDisconnectedServerSocketBoundary(socket => { configureConnectedServerSocketBoundary(socket); });
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot, getDeviceDefaultServerId, getTabActiveServerId, setActiveServerId } = await import('./serverProfiles');
const { getAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { setActiveServerAndSwitch, upsertActivateAndSwitchServer } = await import('./activeServerSwitch');
const baseline = storage.getState();
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | null = null;
let targetId: string;

beforeEach(async () => {
    browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev' });
    await homes.reset();
    storage.setState(baseline, true);
    await homes.addHome({ name: 'Origin', serverUrl: 'https://focus-origin.test', accountId: 'origin-account' });
    targetId = await homes.addHome({ name: 'Target', serverUrl: 'https://focus-target.test', accountId: 'target-account', active: false });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://focus-origin.test', accountId: 'origin-account', request: homes.request });
    installHomeGovernanceBoundaries(homes);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await connection?.dispose();
    connection = null;
    const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
    await serverScopedRpcSocketPool.stopAll();
    browser?.restore();
    browser = null;
});

describe('addressed Home switch storage failure', () => {
    it.each(['saved-profile', 'address'] as const)('never acknowledges a failed tab focus through %s', async entry => {
        if (!connection || !browser) throw new Error('Expected the admitted browser origin Account');
        const setItem = browser.window.Storage.prototype.setItem;
        const storageWrite = vi.spyOn(browser.window.Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
            // The real browser boundary fails only this addressed selection write;
            // credential storage, Home admission and the rollback remain available.
            if (key === 'activeServerId' && value === targetId) throw new Error('Tab focus storage unavailable');
            setItem.call(this, key, value);
        });
        const before = homes.requests.length;
        const attempted = entry === 'saved-profile'
            ? setActiveServerAndSwitch({ serverId: targetId, scope: 'tab' })
            : upsertActivateAndSwitchServer({ serverUrl: 'https://focus-target.test', source: 'manual', scope: 'tab' });

        await expect(attempted).rejects.toBeInstanceOf(Error);
        expect(storageWrite).toHaveBeenCalledWith('activeServerId', targetId);
        expect(getActiveServerSnapshot().serverId).toBe(connection.serverId);
        expect(getAppliedActiveServerSnapshot().serverId).toBe(connection.serverId);
        expect(homes.requests.slice(before).some(request => request.serverUrl === 'https://focus-target.test')).toBe(false);
    });

    it('restores the prior device default when clearing the previous tab focus fails', async () => {
        if (!connection || !browser) throw new Error('Expected the admitted browser origin Account');
        await setActiveServerId(connection.serverId, { scope: 'tab' });
        const removeItem = browser.window.Storage.prototype.removeItem;
        const storageRemove = vi.spyOn(browser.window.Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key) {
            if (key === 'activeServerId') throw new Error('Tab focus storage unavailable');
            removeItem.call(this, key);
        });

        await expect(setActiveServerAndSwitch({ serverId: targetId, scope: 'device' })).rejects.toBeInstanceOf(Error);
        expect(storageRemove).toHaveBeenCalledWith('activeServerId');
        expect(getDeviceDefaultServerId()).toBe(connection.serverId);
        expect(getTabActiveServerId()).toBe(connection.serverId);
        expect(getActiveServerSnapshot().serverId).toBe(connection.serverId);
        expect(getAppliedActiveServerSnapshot().serverId).toBe(connection.serverId);
    });
});
