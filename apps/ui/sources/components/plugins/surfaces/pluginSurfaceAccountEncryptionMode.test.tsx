import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import {
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
    waitForHomeGovernance,
} from '@/dev/testkit/harness/homeGovernanceHarness';

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } =
    await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } =
    await import('@/sync/domains/scope/activeServerAccountScope');
const { invalidateAccountEncryptionModeCache } = await import('@/sync/api/account/apiAccountEncryptionMode');
const { usePluginSurfaceAccountEncryptionMode } = await import('./pluginSurfaceContext');

const modePath = '/v1/account/encryption';
let serverId: string;
let previous = storage.getState();
let previousApplied = getAppliedActiveServerSnapshot();
let previousAvailable = isAppliedActiveServerRuntimeAvailable();

async function currentAccount(accountId: string) {
    // This hook owns disclosure, not connection bootstrap. Publish the real
    // teardown/restoration facts while replacing credentials so the fixture's
    // delayed mode reply cannot also block an unrelated Sync cold restore.
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot(), false);
    await home.switchAccount(serverId, accountId);
    storage.getState().activateProfileScope({ serverId, accountId });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const lifetime = captureActiveServerAccountScopeLifetime();
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://plugin-mode.test', { serverId });
    if (!lifetime || !credentials) throw new Error('Expected the fixture Home Account authority');
    return { lifetime, credentials };
}

describe('usePluginSurfaceAccountEncryptionMode', () => {
    beforeEach(async () => {
        previous = storage.getState();
        previousApplied = getAppliedActiveServerSnapshot();
        previousAvailable = isAppliedActiveServerRuntimeAvailable();
        await home.reset();
        serverId = await home.addHome({ serverUrl: 'https://plugin-mode.test', name: 'Account mode Home', accountId: 'account-a' });
        invalidateAccountEncryptionModeCache();
    });

    afterEach(async () => {
        await standardCleanup();
        retireActiveServerAccountScopeLifetime();
        invalidateAccountEncryptionModeCache();
        await home.reset();
        storage.setState(previous);
        publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
    });

    it('retries cached disclosure when a successor mount currentness fence replaces a retired controller', async () => {
        const account = await currentAccount('account-a');
        const retiredControllerIsCurrent = () => false;
        const successorControllerIsCurrent = () => true;
        const hook = await renderHook((input: Readonly<{ isCurrent: () => boolean }>) => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: account.lifetime,
            credentials: account.credentials,
            isCurrent: input.isCurrent,
        }), { initialProps: { isCurrent: retiredControllerIsCurrent } });

        expect(hook.getCurrent()).toEqual({ status: 'loading' });
        expect(home.requestsFor(modePath)).toEqual([]);
        await hook.rerender({ isCurrent: successorControllerIsCurrent });
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));
        expect(home.requestsFor(modePath)).toHaveLength(1);
        await hook.unmount();
    });

    it('withholds stale Account A and invalidated snapshots until the current Account mode resolves', async () => {
        const accountA = await currentAccount('account-a');
        const accountAResponse = createDeferred<void>();
        const accountBResponse = createDeferred<void>();
        const refreshedAccountBResponse = createDeferred<void>();
        home.answer(serverId, modePath, { respondAfter: accountAResponse.promise, body: { mode: 'e2ee', updatedAt: 1 } });
        const accountAIsCurrent = () => accountA.lifetime.isCurrent();
        const hook = await renderHook((input: Readonly<{
            account: typeof accountA;
            isCurrent: () => boolean;
        }>) => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: input.account.lifetime,
            credentials: input.account.credentials,
            isCurrent: input.isCurrent,
        }), { initialProps: { account: accountA, isCurrent: accountAIsCurrent }, flushOptions: { cycles: 0 } });

        expect(hook.getCurrent()).toEqual({ status: 'loading' });
        await waitForHomeGovernance(() => expect(home.requestsFor(modePath)).toHaveLength(1));
        const accountB = await currentAccount('account-b');
        expect(accountA.lifetime.isCurrent()).toBe(false);
        home.answer(serverId, modePath, { respondAfter: accountBResponse.promise, body: { mode: 'plain', updatedAt: 1 } });
        const accountBIsCurrent = () => accountB.lifetime.isCurrent();
        await hook.rerender({ account: accountB, isCurrent: accountBIsCurrent });
        expect(hook.getCurrent()).toEqual({ status: 'loading' });
        await waitForHomeGovernance(() => expect(home.requestsFor(modePath)).toHaveLength(2));
        await act(async () => accountBResponse.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' }));

        await act(async () => accountAResponse.resolve());
        expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'plain' });
        home.answer(serverId, modePath, { respondAfter: refreshedAccountBResponse.promise, body: { mode: 'e2ee', updatedAt: 1 } });
        await act(async () => invalidateAccountEncryptionModeCache());
        expect(hook.getCurrent()).toEqual({ status: 'loading' });
        await waitForHomeGovernance(() => expect(home.requestsFor(modePath)).toHaveLength(3));
        await act(async () => refreshedAccountBResponse.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'ready', mode: 'e2ee' }));
        expect(home.requestsFor(modePath)).toHaveLength(3);
        await hook.unmount();
    });

    it('reports a terminal refusal only after the pending mode request settles', async () => {
        const account = await currentAccount('account-a');
        const pending = createDeferred<void>();
        home.answer(serverId, modePath, { respondAfter: pending.promise, status: 401, body: {} });
        const isCurrent = () => account.lifetime.isCurrent();
        const hook = await renderHook(() => usePluginSurfaceAccountEncryptionMode({
            accountLifetime: account.lifetime,
            credentials: account.credentials,
            isCurrent,
        }));

        expect(hook.getCurrent()).toEqual({ status: 'loading' });
        await waitForHomeGovernance(() => expect(home.requestsFor(modePath)).toHaveLength(1));
        await act(async () => pending.resolve());
        await waitForHomeGovernance(() => expect(hook.getCurrent()).toEqual({ status: 'unavailable' }));
        await hook.unmount();
    });
});
