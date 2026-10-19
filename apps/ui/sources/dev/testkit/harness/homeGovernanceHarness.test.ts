import { afterEach, expect, it } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from './homeGovernanceHarness';
import { initializeRealAppRuntimeForTests } from './realAppRuntimeHarness';

const homes = createHomeGovernanceHarness();
afterEach(async () => { await homes.reset(); });

it('switches the applied Account when the app entry has not loaded Sync', async () => {
    installHomeGovernanceBoundaries(homes);
    const id = await homes.addHome({ name: 'Cold Governance', serverUrl: 'https://governance-cold.test', accountId: 'account-a' });
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
    const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
    storage.getState().activateProfileScope({ serverId: id, accountId: 'account-a' });
    publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    const { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const previous = captureActiveServerAccountScopeLifetime();
    expect(previous?.scope).toEqual({ serverId: id, accountId: 'account-a' });

    await homes.switchAccount(id, 'account-b');

    expect(previous?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toEqual({ serverId: id, accountId: 'account-b' });
});

it('persists genuine Home credentials and retires a focused Account on replacement and reset', async () => {
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    const id = await homes.addHome({ name: 'Governance', serverUrl: 'https://governance-custody.test', accountId: 'account-a' });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://governance-custody.test', { serverId: id });
    if (!credentials) throw new Error('Home credentials unavailable');
    await restoreConnectionToActiveServer(credentials);
    const { getActiveServerAccountScope, captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    expect(getActiveServerAccountScope()).toEqual({ serverId: id, accountId: 'account-a' });
    const captured = captureActiveServerAccountScopeLifetime();
    expect(captured?.isCurrent()).toBe(true);
    let release: () => void = () => undefined;
    homes.answer(id, '/v1/lifetime-probe', { body: { account: 'a' }, respondAfter: new Promise<void>(resolve => { release = resolve; }) });
    const { serverFetch, StaleServerGenerationError, ServerFetchAbortedForServerSwitchError } = await import('@/sync/http/client');
    const pending = serverFetch('/v1/lifetime-probe', undefined, { retry: 'none' }).then(
        () => false,
        error => error instanceof StaleServerGenerationError || error instanceof ServerFetchAbortedForServerSwitchError
            || (error instanceof DOMException && error.name === 'AbortError'),
    );
    await waitForHomeGovernance(() => expect(homes.requestsFor('/v1/lifetime-probe')).toHaveLength(1));
    await homes.switchAccount(id, 'account-b');
    release();
    expect(await pending).toBe(true);
    expect(captured?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toEqual({ serverId: id, accountId: 'account-b' });
    const replacement = captureActiveServerAccountScopeLifetime();
    await homes.reset();
    expect(replacement?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toBeNull();
    expect(await TokenStorage.getCredentialsForServerUrl('https://governance-custody.test', { serverId: id })).toBeNull();
});

it('addresses the same fixture Home by its published identity without selecting a neighboring Home', async () => {
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    const serverUrl = 'https://governance-published.test';
    const identity = 'srv_governance_published';
    const profileId = await homes.addHome({ name: 'Published', serverUrl, serverIdentityId: identity, accountId: 'account-a' });
    const neighbor = await homes.addHome({ name: 'Neighbor', serverUrl: 'https://governance-neighbor.test',
        serverIdentityId: 'srv_governance_neighbor', accountId: 'neighbor', active: false });
    homes.answer(identity, '/v1/identity-probe', { body: { home: 'published' } });
    const token = homes.findByServerUrl(serverUrl)!.token;
    const response = await homes.request(`${serverUrl}/v1/identity-probe`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await response.json()).toEqual({ home: 'published' });
    expect(homes.requestsFor('/v1/identity-probe')).toMatchObject([{ serverId: profileId, serverUrl }]);
    expect(homes.artifacts(identity)).toBe(homes.artifacts(profileId));
    expect(homes.artifacts(identity)).not.toBe(homes.artifacts(neighbor));
    await homes.switchAccount(identity, 'replacement');
    expect(homes.findByServerUrl(serverUrl)?.accountId).toBe('replacement');
    expect(homes.findByServerUrl('https://governance-neighbor.test')?.accountId).toBe('neighbor');
});

it('retains both named Account approval requirements when seeding them in sequence', async () => {
    await initializeRealAppRuntimeForTests();
    installHomeGovernanceBoundaries(homes);
    const serverUrl = 'https://governance-policy.test';
    const profileId = await homes.addHome({ name: 'Policy', serverUrl, accountId: 'account-a' });
    await homes.requireUiApproval(profileId, 'machines.processes.kill');
    await homes.requireUiApproval(profileId, 'machines.processes.stop');
    const token = homes.findByServerUrl(serverUrl)!.token;
    const response = await homes.request(`${serverUrl}/v2/account/settings`, { headers: { Authorization: `Bearer ${token}` } });
    expect(await response.json()).toMatchObject({ content: { t: 'plain', v: { actionsSettingsV1: { actions: {
        'machines.processes.kill': { approvalRequiredSurfaces: ['ui'] },
        'machines.processes.stop': { approvalRequiredSurfaces: ['ui'] },
    } } } } });
});
