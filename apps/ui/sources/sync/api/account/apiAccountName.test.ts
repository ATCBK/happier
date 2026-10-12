import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { profileDefaults } = await import('@/sync/domains/profiles/profile');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { storage } = await import('@/sync/domains/state/storageStore');
const { activateStorageAccountScope } = await import('@/dev/testkit/runtime/storageRuntime');
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');

const credentials = { token: createAccountTokenForTests('account-a', { currentAccount: true }) };
let serverId: string;
let disposeScope: (() => void) | undefined;

beforeEach(async () => {
    resetScopedHomeActionExecutorsForTests();
    await homes.reset();
    await loadSyncSingletonForTests();
    serverId = await homes.addHome({ name: 'Name Home', serverUrl: 'https://name.example.test', accountId: 'account-a', currentAccount: true });
    storage.getState().applyProfile({ ...profileDefaults, id: 'account-a', timestamp: 1, name: 'Before', username: 'alice' });
    const active = await activateStorageAccountScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' });
    disposeScope = () => active.dispose();
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    storage.setState({ endpointStatus: 'online' });
});

afterEach(async () => {
    disposeScope?.();
    disposeScope = undefined;
    await homes.reset();
});

function installResponse(body: unknown, status = 200, beforeJson?: () => void) {
    homes.answer(serverId, 'POST /v1/account/profile', { select: () => { beforeJson?.(); return { body, status }; } });
}

describe('setAccountName', () => {
    it('sends a trimmed canonical name and merges only the acknowledged fields with the latest profile', async () => {
        const response = { name: 'Chosen Name', firstName: 'Chosen Name', lastName: null, timestamp: 5 };
        installResponse(response, 200, () => storage.getState().applyProfile({ ...storage.getState().profile, username: 'changed-in-flight' }));
        const { setAccountName } = await import('./apiAccountName');
        await expect(setAccountName(credentials, ' Chosen Name ')).resolves.toEqual(response);
        expect(homes.requestsFor('/v1/account/profile')[0]?.input).toEqual({ name: 'Chosen Name' });
        expect(storage.getState().profile).toMatchObject({ ...response, username: 'changed-in-flight' });
    });

    it('clears whitespace-only names without retaining the old legacy projection', async () => {
        installResponse({ name: null, firstName: null, lastName: null, timestamp: 5 });
        const { setAccountName } = await import('./apiAccountName');
        await setAccountName(credentials, '   ');
        expect(storage.getState().profile).toMatchObject({ name: null, firstName: null, lastName: null });
        expect(homes.requestsFor('/v1/account/profile')[0]?.input).toEqual({ name: null });
    });

    it('does not apply a late acknowledgment after switching Accounts on the same Home', async () => {
        installResponse({ name: 'Account A', firstName: 'Account A', lastName: null, timestamp: 5 }, 200, () => {
            const scope = storage.getState().profileScope!;
            storage.getState().activateProfileScope({ ...scope, accountId: 'account-b' });
            storage.getState().applyProfile({ ...profileDefaults, id: 'account-b', name: 'Account B' });
        });
        const { setAccountName } = await import('./apiAccountName');
        await expect(setAccountName(credentials, 'Account A')).rejects.toMatchObject({ name: 'HappyError', canTryAgain: false });
        expect(storage.getState().profile).toMatchObject({ id: 'account-b', name: 'Account B' });
    });

    it('retains current profile when the acknowledged response is invalid or the server refuses the mutation', async () => {
        const { setAccountName } = await import('./apiAccountName');
        installResponse({ name: 'Untrusted' });
        await expect(setAccountName(credentials, 'Untrusted')).rejects.toThrow();
        installResponse({ error: 'unsupported' }, 404);
        await expect(setAccountName(credentials, 'Untrusted')).rejects.toMatchObject({ name: 'HappyError', status: 404 });
        expect(storage.getState().profile.name).toBe('Before');
    });

    it('does not overwrite a newer profile name with an older acknowledgment', async () => {
        installResponse({ name: 'Older', firstName: 'Older', lastName: null, timestamp: 5 }, 200, () => {
            storage.getState().applyProfile({ ...storage.getState().profile, name: 'Newer', timestamp: 6 });
        });
        const { setAccountName } = await import('./apiAccountName');
        await setAccountName(credentials, 'Older');
        expect(storage.getState().profile).toMatchObject({ name: 'Newer', timestamp: 6 });
    });

    it('refuses credentials for another Account before issuing its mutation', async () => {
        installResponse({ name: 'Wrong Account', firstName: 'Wrong Account', lastName: null, timestamp: 5 });
        const { setAccountName } = await import('./apiAccountName');
        const otherCredentials = { ...credentials, token: `header.${btoa(JSON.stringify({ sub: 'account-b' }))}.signature` };
        await expect(setAccountName(otherCredentials, 'Wrong Account')).rejects.toMatchObject({ name: 'HappyError', canTryAgain: false });
        expect(storage.getState().profile.name).toBe('Before');
        expect(homes.requestsFor('/v1/account/profile')).toHaveLength(0);
    });
});
