import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as SecureStore from 'expo-secure-store';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';

// Install genuine HTTP/Socket boundaries before collecting the immutable real owners.
await initializeAuthRouteRuntimeForTests();
const { AuthProvider, getCurrentAuth, setCurrentAuth } = await import('./AuthContext');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { upsertServerProfile, setServerProfileIdentityForUrl, setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
const storage = getStorage();

function buildTokenWithSub(sub: string): string {
    return `hdr.${Buffer.from(JSON.stringify({ sub })).toString('base64')}.sig`;
}

async function prepareHomes(previousToken = buildTokenWithSub('account-a')) {
    const homes = [];
    for (const name of ['a', 'b']) {
        const profile = await upsertServerProfile({ serverUrl: `https://home-${name}.example.test`, name: `Home ${name}` });
        const serverId = `srv_archive_home_${name}`;
        await setServerProfileIdentityForUrl(profile.serverUrl, serverId);
        homes.push({ serverId, serverUrl: profile.serverUrl });
    }
    const [homeA, homeB] = homes;
    if (!homeA || !homeB) throw new Error('Expected both Home fixtures');
    const credentialsA = { token: previousToken };
    const credentialsB = { token: buildTokenWithSub('account-b') };
    await TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, homeA, credentialsA);
    await TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, homeB, credentialsB);
    storage.getState().beginSessionArchive({ serverId: homeA.serverId, sessionId: 'session' });
    storage.getState().beginSessionArchive({ serverId: homeB.serverId, sessionId: 'session' });
    const archivesA = storage.getState().sessionArchiveOperations[homeA.serverId];
    const archivesB = storage.getState().sessionArchiveOperations[homeB.serverId];
    if (!archivesA || !archivesB) throw new Error('Expected pending archives on both Homes');
    return { homeA, homeB, credentialsA, credentialsB, archivesA, archivesB };
}

describe('AuthContext archive operation retirement', () => {
    beforeEach(async () => {
        await disconnectActiveServerConnection();
        storage.setState(storage.getInitialState(), true);
        setCurrentAuth(null);
    });

    afterEach(async () => {
        await standardCleanup();
        await disconnectActiveServerConnection();
        vi.restoreAllMocks();
        setCurrentAuth(null);
    });

    it.each([
        { accountId: 'account-a', previousKind: 'valid', previousToken: buildTokenWithSub('account-a'), replacesAccount: false, urlOnly: false },
        { accountId: 'account-new', previousKind: 'valid', previousToken: buildTokenWithSub('account-a'), replacesAccount: true, urlOnly: true },
        { accountId: 'account-new', previousKind: 'malformed', previousToken: 'malformed-previous-token', replacesAccount: true, urlOnly: false },
    ])('retires only the replaced Home archive operations (account=$accountId, previous=$previousKind)', async ({ accountId, previousToken, replacesAccount, urlOnly }) => {
        const { homeA, homeB, credentialsB, archivesA, archivesB } = await prepareHomes(previousToken);
        await setActiveServerId(homeB.serverId);
        const screen = await renderScreen(<AuthProvider initialCredentials={credentialsB}><></></AuthProvider>);
        try {
            await act(async () => {
                await getCurrentAuth()!.loginWithCredentials({ token: buildTokenWithSub(accountId).replace(/sig$/, 'refreshed') }, {
                    target: urlOnly ? { serverUrl: homeA.serverUrl } : homeA,
                });
            });
            expect(storage.getState().sessionArchiveOperations[homeA.serverId]).toBe(replacesAccount ? undefined : archivesA);
            expect(storage.getState().sessionArchiveOperations[homeB.serverId]).toBe(archivesB);
            expect(getCurrentAuth()?.credentials).toEqual(credentialsB);
        } finally {
            await screen.unmount();
        }
    });

    it.each(['focused-home', 'all-credentials'] as const)('retires archive operations only for the Homes forgotten by %s logout', async (scope) => {
        const { homeA, homeB, credentialsA, archivesB } = await prepareHomes();
        await setActiveServerId(homeA.serverId);
        const screen = await renderScreen(<AuthProvider initialCredentials={credentialsA}><></></AuthProvider>);
        try {
            await act(async () => { await getCurrentAuth()!.logout({ scope }); });
            expect(storage.getState().sessionArchiveOperations[homeA.serverId]).toBeUndefined();
            expect(storage.getState().sessionArchiveOperations[homeB.serverId]).toBe(scope === 'all-credentials' ? undefined : archivesB);
        } finally {
            await screen.unmount();
        }
    });

    it('keeps login persistence and archive retirement on the initiating Home when focus changes during a credential guard read', async () => {
        const { homeA, homeB, credentialsA, credentialsB, archivesB } = await prepareHomes();
        await setActiveServerId(homeA.serverId);
        const screen = await renderScreen(<AuthProvider initialCredentials={credentialsA}><></></AuthProvider>);
        const readGate = createDeferred<void>();
        const readSecureStore = SecureStore.getItemAsync;
        let held = false;
        // Native credentials may already be cached. Delay the first-key custody
        // storage read instead, before any credential persistence can occur.
        vi.spyOn(SecureStore, 'getItemAsync').mockImplementation(async (key) => {
            const raw = await readSecureStore(key);
            if (!held && key.includes('pending_external_auth')) {
                held = true;
                await readGate.promise;
            }
            return raw;
        });
        const newCredentials = { token: buildTokenWithSub('account-new') };
        let login: Promise<unknown> | undefined;
        try {
            await act(async () => {
                login = getCurrentAuth()!.loginWithCredentials(newCredentials);
                void login.catch(() => undefined);
                await vi.waitFor(() => expect(held).toBe(true));
                await setActiveServerId(homeB.serverId);
                readGate.resolve();
                await login;
            });
            expect(await TokenStorage.getCredentialsForServerUrl(homeA.serverUrl, homeA)).toEqual(newCredentials);
            expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, homeB)).toEqual(credentialsB);
            expect(storage.getState().sessionArchiveOperations[homeA.serverId]).toBeUndefined();
            expect(storage.getState().sessionArchiveOperations[homeB.serverId]).toBe(archivesB);
            // Focus restoration is asynchronous; this hidden Home must never
            // publish its newly persisted bearer into that other Home's bridge.
            expect(getCurrentAuth()?.credentials).not.toEqual(newCredentials);
        } finally {
            readGate.resolve();
            await act(async () => { await login?.catch(() => undefined); });
            await screen.unmount();
        }
    });

    it('preserves archive operations when the credential write fails', async () => {
        const { homeA, homeB, credentialsB, archivesA, archivesB } = await prepareHomes();
        await setActiveServerId(homeB.serverId);
        const screen = await renderScreen(<AuthProvider initialCredentials={credentialsB}><></></AuthProvider>);
        vi.spyOn(SecureStore, 'setItemAsync').mockRejectedValue(new Error('Native credential write failed'));
        try {
            await act(async () => {
                await expect(getCurrentAuth()!.loginWithCredentials({ token: buildTokenWithSub('account-new') }, { target: homeA })).rejects.toThrow();
            });
            expect(storage.getState().sessionArchiveOperations[homeA.serverId]).toBe(archivesA);
            expect(storage.getState().sessionArchiveOperations[homeB.serverId]).toBe(archivesB);
        } finally {
            await screen.unmount();
        }
    });
});
