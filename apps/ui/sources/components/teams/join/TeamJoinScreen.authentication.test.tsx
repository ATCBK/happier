import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import {
    installWebLockManagerMock,
} from '@/auth/storage/tokenStorage.web.testHelpers';
import {
    createAccountTokenForTests,
    createHomeGovernanceHarness,
    installHomeGovernanceBoundaries,
} from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { setActiveServerId, setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';

installTokenStorageWebPlatformMocks();
const browserStorage = await vi.hoisted(async () => {
    const { installLocalStorageMock } = await import('@/auth/storage/tokenStorage.web.testHelpers');
    return { ...installLocalStorageMock(), backend: globalThis.localStorage };
});
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
// This regression is about the real credential writer and its subscribers,
// rather than the governance harness's read-only Account fixture.
vi.mocked(TokenStorage.getCredentialsForServerUrl).mockRestore();
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
setRuntimeFetch(home.request);
// Match the app entry so credential adoption publishes the real Account scope
// instead of stopping at an unloaded Sync singleton in this composed journey.
await import('@/sync/syncEngine');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { TeamJoinScreen } = await import('./TeamJoinScreen');

let restoreLocks: () => void;
let stopCredentialObservation: (() => void) | undefined;
beforeEach(() => {
    vi.stubGlobal('localStorage', browserStorage.backend);
    browserStorage.store.clear();
    restoreLocks = installWebLockManagerMock().restore;
});
afterEach(async () => {
    stopCredentialObservation?.();
    stopCredentialObservation = undefined;
    await standardCleanup();
    await disconnectActiveServerConnection();
    await home.reset();
    restoreLocks();
});
afterAll(() => browserStorage.restore());

it.each(['key_challenge', 'email_password'] as const)('retains the invitation authentication host through credential adoption and offers Open Team after atomic %s provisioning', async method => {
    const identity = `srv_${method}_join`;
    const origin = `https://${method.replaceAll('_', '-')}-join.test`;
    const mode = method === 'key_challenge' ? 'keyed' : 'keyless';
    const serverId = await home.addHome({ name: 'Acme', serverUrl: origin,
        serverIdentityId: identity, accountId: null, teamsEnabled: true });
    await setServerProfileIdentityForUrl(origin, identity);
    await setActiveServerId(identity, { scope: 'device' });
    const features = createRootLayoutFeaturesResponse({ capabilities: {
        serverIdentity: { serverIdentityId: identity }, server: { canonicalServerUrl: origin },
    } });
    tryWriteServerEnabledBitInPlace(features, 'teams', true);
    home.answer(serverId, '/v1/features', { body: features });
    const token = 'a'.repeat(43);
    home.answer(serverId, '/v1/team-invitations/preview', { body: {
        outcome: 'ok', preview: {
            home: { serverId: identity, displayName: 'Acme', storageMode: null },
            team: { teamId: 'team-1', name: 'Acme Team', logo: null, accentSeed: 'team-1' },
            role: 'member', historyAccess: 'from_membership', state: 'active',
            expiresAt: Date.UTC(2030, 0, 1), recipientEmailMask: null,
        },
    } });
    home.answer(serverId, '/v1/auth/entry', { body: {
        v: 1, state: 'admission_required', scope: { kind: 'invitation' },
        home: { serverId: identity, displayName: 'Acme', storageMode: null },
        team: { teamId: 'team-1', name: 'Acme Team', logo: null },
        invitationEmailVerificationRequired: false,
        actions: [{ kind: 'authenticate', methodId: method, action: 'provision',
            mode, origin: 'home', presentation: { displayName: method === 'key_challenge' ? 'Device key' : 'Email and password' } }],
        autoRedirect: null,
    } });
    const credentials = { token: createAccountTokenForTests('new-account', { currentAccount: true }) };
    const authPath = method === 'key_challenge' ? '/v1/auth' : '/v1/auth/email/provision';
    home.answer(serverId, authPath, { body: method === 'key_challenge' ? credentials : {
        ...credentials, accountId: 'new-account', teamId: 'team-1',
    } });
    const screen = await renderScreen(<AuthProvider initialCredentials={null}>
        <TeamJoinScreen token={token} homeTarget={identity} />
    </AuthProvider>);
    for (let attempt = 0; attempt < 10; attempt += 1) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    }
    expect(screen.findByTestId(`team-auth-entry-action:${method}`), screen.getTextContent()).not.toBeNull();
    await screen.pressByTestIdAsync(`team-auth-entry-action:${method}`);
    // The chosen method continues inside the same split shell, under the Team's
    // identity, instead of replacing the page with a bare full-width form.
    expect(screen.findByTestId('team-auth-step-shell'), screen.getTextContent()).not.toBeNull();
    expect(screen.findByTestId('team-auth-step-team-name')?.props.children).toBe('Acme Team');
    const actionId = `home-auth-${method}-provision-${mode}`;
    const submitId = method === 'key_challenge' ? actionId : 'email-password-create';
    if (method === 'email_password') {
        // The entry card already chose this form; the step does not ask again.
        expect(screen.findByTestId(actionId)).toBeNull();
        await act(async () => {
            screen.changeTextByTestId('email-password-email', 'person@example.test');
            screen.changeTextByTestId('email-password-password', 'a calm sixteen plus password');
            screen.changeTextByTestId('email-password-confirm', 'a calm sixteen plus password');
        });
    }
    const credentialWritten = createDeferred<void>();
    const releaseStorage = createDeferred<void>();
    let credentialChanged = false;
    stopCredentialObservation = subscribeHomeCredentialChange(() => {
        credentialChanged = true;
        credentialWritten.resolve();
    });
    // The genuine browser storage-lock boundary retains the write while its
    // subscribers render. A single async act around the whole submission
    // batches this reachable adoption frame away and misses the cancellation.
    const requestLock = navigator.locks.request.bind(navigator.locks);
    const lockRequest = vi.spyOn(navigator.locks, 'request').mockImplementation(async <T,>(
        name: string,
        optionsOrCallback: LockOptions | ((lock: Lock | null) => T | PromiseLike<T>),
        optionalCallback?: (lock: Lock | null) => T | PromiseLike<T>,
    ): Promise<T> => {
        const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : optionalCallback;
        if (!callback) throw new Error('Missing storage-lock callback');
        return await requestLock(name, async lock => {
            const result = await callback(lock);
            if (credentialChanged) await releaseStorage.promise;
            return result;
        });
    });
    try {
        act(() => { screen.pressByTestId(submitId); });
        await credentialWritten.promise;
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(screen.findByTestId(submitId), screen.getTextContent()).not.toBeNull();
    } finally {
        releaseStorage.resolve();
        lockRequest.mockRestore();
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
    }
    expect(screen.findByTestId('team-auth-entry-admission-complete-action'), screen.getTextContent()).not.toBeNull();
    expect(await TokenStorage.getCredentialsForServerUrl(origin, { serverId: identity })).toEqual(credentials);
    expect(home.requestsFor(authPath).map(request => request.input)).toEqual([
        expect.objectContaining({ admission: { kind: 'team_invitation', token } }),
    ]);
    // Provisioning committed admission; re-reading a consumed bearer would lose
    // the completed state and can never be how this journey reaches its Team.
    expect(home.requestsFor('/v1/auth/entry')).toHaveLength(1);
});
