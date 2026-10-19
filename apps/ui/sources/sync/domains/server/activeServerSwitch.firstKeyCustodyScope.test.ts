import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

installTokenStorageWebPlatformMocks();

installDisconnectedServerSocketBoundary(socket => { socket.connected = true; });
const modal = vi.hoisted(() => ({ show: vi.fn<(config: Readonly<{ component: unknown; props?: unknown }>) => string>() }));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { show: modal.show } }).module;
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const baseline = storage.getState();
const profiles = await import('./serverProfiles');
const switches = await import('./activeServerSwitch');
const { getAppliedActiveServerId } = await import('@/sync/runtime/orchestration/connectionManager');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { guardAccountEncryptionFirstKeyCredentialMutation } = await import('@/sync/ops/account/accountEncryptionFirstKeyExternalAuth');
const { FirstKeyRecoveryModal } = await import('@/components/account/FirstKeyRecoveryModal');

describe('active Home switch and retained first-key custody', () => {
    let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | null = null;
    let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;

    beforeEach(async () => {
        browser = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev' });
        await homes.reset();
        storage.setState(baseline, true);
        modal.show.mockReset();
        // The real lifecycle chooses recovery; only its modal presentation is
        // replaced, and the person keeps the retained custody.
        modal.show.mockImplementation(config => {
            if (config.component !== FirstKeyRecoveryModal || !config.props || typeof config.props !== 'object'
                || !('onSettled' in config.props) || typeof config.props.onSettled !== 'function') {
                throw new Error('Expected the real first-key recovery presentation');
            }
            const { onSettled } = config.props;
            queueMicrotask(() => onSettled('keep'));
            return 'first-key-recovery';
        });
    });

    afterEach(async () => {
        await connection?.dispose();
        connection = null;
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        await serverScopedRpcSocketPool.stopAll();
        browser?.restore();
        browser = null;
        vi.restoreAllMocks();
    });

    it('lets focus move between other Homes, keeps Home A\'s custody, and surfaces it on return', async () => {
        const homeA = await homes.addHome({ serverUrl: 'https://home-a.example.test', name: 'A', accountId: 'account-home-a', active: false });
        const homeB = await homes.addHome({ serverUrl: 'https://home-b.example.test', name: 'B', accountId: 'account-home-b' });
        const homeC = await homes.addHome({ serverUrl: 'https://home-c.example.test', name: 'C', accountId: 'account-home-c', active: false });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-b.example.test', accountId: 'account-home-b', request: homes.request });
        installHomeGovernanceBoundaries(homes);
        await expect(TokenStorage.setPendingExternalAuth({
            provider: 'github',
            proof: 'proof',
            secret: 'secret',
            serverId: homeA,
            serverUrl: 'https://home-a.example.test',
            accountEncryptionFirstKey: {
                accountId: 'account-home-a',
                requestDigest: `aemrb1_${'A'.repeat(43)}`,
                requestJson: '{}',
                pending: 'pending',
                createdAt: Date.now(),
                expiresAt: Date.now() + 60_000,
                migrationSubmissionAttempted: true,
            },
        }, { serverUrl: 'https://home-a.example.test', serverId: homeA })).resolves.toBe(true);
        const readHomeACustody = async () => (
            await TokenStorage.readPendingExternalAuthStateForServerUrl('https://home-a.example.test', { serverId: homeA })
        ).value?.accountEncryptionFirstKey?.migrationSubmissionAttempted ?? null;

        // An unrelated focus change is not a credential mutation of Home A.
        expect(profiles.getActiveServerId()).toBe(homeB);
        await expect(switches.setActiveServerAndSwitch({ serverId: homeC, scope: 'device' })).resolves.toBe('switched');
        expect(profiles.getActiveServerId()).toBe(homeC);
        expect(getAppliedActiveServerId()).toBe(homeC);
        expect(modal.show).not.toHaveBeenCalled();
        await expect(readHomeACustody()).resolves.toBe(true);

        // Returning to Home A keeps the custody and presents its recovery.
        await expect(switches.setActiveServerAndSwitch({ serverId: homeA, scope: 'device' })).resolves.toBe('switched');
        expect(profiles.getActiveServerId()).toBe(homeA);
        expect(getAppliedActiveServerId()).toBe(homeA);
        expect(modal.show).toHaveBeenCalledWith(expect.objectContaining({ component: FirstKeyRecoveryModal }));
        await expect(guardAccountEncryptionFirstKeyCredentialMutation({ serverUrl: 'https://home-a.example.test', serverId: homeA }))
            .resolves.toMatchObject({ kind: 'finish_encryption_setup' });
        await expect(readHomeACustody()).resolves.toBe(true);
    });
});
