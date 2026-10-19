import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    AccountSettingsV2GetResponseSchema,
    AccountSettingsV2UpdateRequestSchema,
    AccountSettingsV2UpdateResponseSchema,
} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

import { createAccountSettingsHttpBoundary, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { runtimeFetch } from '@/utils/system/runtimeFetch';
import { serveActionHomes } from './actionHomesHttpHarness';
import { initializeRealAppRuntimeForTests } from './realAppRuntimeHarness';

await initializeRealAppRuntimeForTests();

describe('served Account Settings HTTP boundary', () => {
    it.each([false, true])('restores the prior logical Account after Home identity adoption (prior Account: %s)', async preexisting => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const { upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
        const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
        const { parseToken } = await import('@/utils/auth/parseToken');
        const serverUrl = `https://served-adoption-${preexisting}.example.test`;
        const identity = `srv_served_adoption_${preexisting}`;
        const profile = await upsertServerProfileOnly({ serverUrl });
        const previous = preexisting ? { token: createAccountTokenForTests('prior-account') } : null;
        if (previous) expect(await TokenStorage.setCredentialsForServerUrl(serverUrl, { serverId: profile.id }, previous)).toBe(true);
        const fixture = await serveAccountHomes({ homes: [{ key: 'home', serverUrl, accountId: 'fixture-account' }], route: () => undefined });
        try {
            expect(await setServerProfileIdentityForUrl(serverUrl, identity)).not.toBeNull();
            const installed = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: identity });
            expect(parseToken(installed!.token)).toBe('fixture-account');
            await fixture.dispose();
            expect(await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId: identity })).toEqual(previous);
        } finally {
            await fixture.dispose();
            await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId: identity });
        }
    });

    it('retires verified Home credentials across fixture reuse and fences an Account switch', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const serverUrl = 'https://served-home-retirement.test';
        for (const accountId of ['retirement-a', 'retirement-b']) {
            const fixture = await serveAccountHomes({ homes: [{ key: 'home', serverUrl,
                serverIdentityId: 'srv_served_retirement', accountId }], route: () => undefined });
            const account = await captureLazyActionAccountContext(fixture.homes.home!.id);
            try {
                expect(account.accountId).toBe(accountId);
                expect(account.accountLifetime.isCurrent()).toBe(true);
                await fixture.switchAccount('home', `${accountId}-replacement`);
                expect(account.accountLifetime.isCurrent()).toBe(false);
                const replacement = await captureLazyActionAccountContext(fixture.homes.home!.id);
                try {
                    expect(replacement.accountId).toBe(`${accountId}-replacement`);
                    expect(replacement.accountLifetime.isCurrent()).toBe(true);
                } finally { replacement.dispose(); }
            } finally { account.dispose(); await fixture.dispose(); }
            expect(await TokenStorage.getCredentialsForServerUrl(serverUrl,
                { serverId: 'srv_served_retirement' })).toBeNull();
        }
    });

    it.each(['removed', 'replaced'] as const)('preserves credentials %s by the exercised flow during cleanup', async outcome => {
        await initializeRealAppRuntimeForTests();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const fixture = await serveAccountHomes({ homes: [{ key: 'home',
            serverUrl: `https://served-cleanup-${outcome}.example.test`,
            serverIdentityId: `srv_served_cleanup_${outcome}`, accountId: 'cleanup-account' }], route: () => undefined });
        const home = fixture.homes.home!;
        const replacement = { token: createAccountTokenForTests('replacement-account') };
        if (outcome === 'removed') {
            expect(await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id })).toBe(true);
        } else {
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, replacement)).toBe(true);
        }
        await fixture.dispose();
        const current = await TokenStorage.getCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        expect(current).toEqual(outcome === 'removed' ? null : replacement);
    });

    it('surfaces device storage failure when cleanup still owns the credential write', async () => {
        await initializeRealAppRuntimeForTests();
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const secureStore = await import('expo-secure-store');
        const fixture = await serveAccountHomes({ homes: [{ key: 'home',
            serverUrl: 'https://served-cleanup-failure.example.test',
            serverIdentityId: 'srv_served_cleanup_failure', accountId: 'cleanup-account' }], route: () => undefined });
        const home = fixture.homes.home!;
        const failure = new Error('Device storage unavailable');
        const remove = vi.spyOn(secureStore, 'deleteItemAsync').mockRejectedValue(failure);
        try {
            await expect(fixture.dispose()).rejects.toBe(failure);
        } finally {
            remove.mockRestore();
            await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        }
    });

    it('durably retires a shipped legacy key and refuses a stale replacement', async () => {
        const legacy = { themePreference: 'dark', recentMachinePaths: [{ machineId: 'machine-a', path: '/work' }] };
        const committed = { t: 'plain' as const, v: { themePreference: 'dark' } };
        const fixture = await serveAccountHomes({
            homes: [{ key: 'account', serverUrl: 'https://settings-cas.test', accountId: 'settings-cas-account', settings: legacy }],
            route: () => undefined,
        });
        try {
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const credentials = await TokenStorage.getCredentialsForServerUrl(fixture.homes.account!.serverUrl);
            expect(credentials).not.toBeNull();
            const endpoint = `${fixture.homes.account!.serverUrl}/v2/account/settings`;
            const headers = { Authorization: `Bearer ${credentials!.token}`, 'Content-Type': 'application/json' };
            const initial = AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers })).json());
            expect(initial).toEqual({ content: { t: 'plain', v: legacy }, version: 1 });

            const response = await runtimeFetch(endpoint, { method: 'POST', headers,
                body: JSON.stringify(AccountSettingsV2UpdateRequestSchema.parse({ content: committed, expectedVersion: initial.version })) });
            expect(response.status).toBe(200);
            expect(AccountSettingsV2UpdateResponseSchema.parse(await response.json())).toEqual({ success: true, version: 2 });
            expect(AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers })).json()))
                .toEqual({ content: committed, version: 2 });

            const stale = await runtimeFetch(endpoint, { method: 'POST', headers,
                body: JSON.stringify(AccountSettingsV2UpdateRequestSchema.parse({ content: { t: 'plain', v: legacy }, expectedVersion: 1 })) });
            expect(stale.status).toBe(200);
            expect(AccountSettingsV2UpdateResponseSchema.parse(await stale.json())).toEqual({
                success: false, error: 'version-mismatch', currentVersion: 2, currentContent: committed,
            });
            expect(AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers })).json()))
                .toEqual({ content: committed, version: 2 });

            // The real Local Agent keeper replaces its Account on this same Home
            // and restores Settings. A captured old bearer still addresses A,
            // not whichever Account is now selected on the device.
            await fixture.switchAccount('account', 'settings-cas-account-b');
            const accountB = await TokenStorage.getCredentialsForServerUrl(fixture.homes.account!.serverUrl);
            expect(accountB).not.toBeNull();
            const headersB = { Authorization: `Bearer ${accountB!.token}`, 'Content-Type': 'application/json' };
            expect(AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers: headersB })).json()))
                .toEqual({ content: null, version: 0 });
            const contentB = { t: 'plain' as const, v: { themePreference: 'light' } };
            const writeB = await runtimeFetch(endpoint, { method: 'POST', headers: headersB, body: JSON.stringify(
                AccountSettingsV2UpdateRequestSchema.parse({ content: contentB, expectedVersion: 0 }),
            ) });
            expect(AccountSettingsV2UpdateResponseSchema.parse(await writeB.json())).toEqual({ success: true, version: 1 });
            expect(AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers })).json()))
                .toEqual({ content: committed, version: 2 });
            const contentA = { t: 'plain' as const, v: { themePreference: 'dark', preferredLanguage: 'fr' } };
            const writeA = await runtimeFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(
                AccountSettingsV2UpdateRequestSchema.parse({ content: contentA, expectedVersion: 2 }),
            ) });
            expect(AccountSettingsV2UpdateResponseSchema.parse(await writeA.json())).toEqual({ success: true, version: 3 });
            expect(AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers: headersB })).json()))
                .toEqual({ content: contentB, version: 1 });
            fixture.replaceAccountSettings('account', { settings: { preferredLanguage: 'de' }, version: 2 });
            const replacedB = { content: { t: 'plain', v: { preferredLanguage: 'de' } }, version: 2 };
            expect(AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers: headersB })).json())).toEqual(replacedB);
            await fixture.switchAccount('account', 'settings-cas-account');
            expect(AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers })).json()))
                .toEqual({ content: contentA, version: 3 });
            expect(AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers: headersB })).json())).toEqual(replacedB);

        } finally {
            await fixture.dispose();
        }
    });

    it('commits an encrypted envelope from the new E2EE Account empty baseline', async () => {
        const serverUrl = 'https://settings-cas-encrypted.test';
        const accountId = 'settings-cas-encrypted-account';
        const boundary = createAccountSettingsHttpBoundary({
            serverUrl,
            initialAccounts: [{ accountId, snapshot: { content: null, version: 0 } }],
        });
        const endpoint = `${serverUrl}/v2/account/settings`;
        const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
        const initial = boundary.handle(endpoint, { headers });
        expect(initial).toBeDefined();
        expect(AccountSettingsV2GetResponseSchema.parse(await initial!.json())).toEqual({ content: null, version: 0 });
        // Ciphertext belongs to the client crypto owner; the server stores its opaque envelope.
        const content = { t: 'encrypted' as const, c: 'opaque-client-ciphertext' };
        const response = boundary.handle(endpoint, { method: 'POST', headers, body: JSON.stringify(
            AccountSettingsV2UpdateRequestSchema.parse({ content, expectedVersion: 0 }),
        ) });
        expect(response).toBeDefined();
        expect(AccountSettingsV2UpdateResponseSchema.parse(await response!.json())).toEqual({ success: true, version: 1 });
        const committed = boundary.handle(endpoint, { headers });
        expect(committed).toBeDefined();
        expect(AccountSettingsV2GetResponseSchema.parse(await committed!.json())).toEqual({ content, version: 1 });
    });

});

let served: Awaited<ReturnType<typeof serveActionHomes>> | null = null;
afterEach(async () => {
    await served?.dispose();
    served = null;
});

it('restores a genuine focused Account and retires its captured lifetime on replacement', async () => {
    await initializeRealAppRuntimeForTests();
    served = await serveActionHomes({ homes: [
        { key: 'other', serverUrl: 'https://action-other.test', accountId: 'account-other', serverIdentityId: 'srv_action_other' },
        { key: 'focused', serverUrl: 'https://action-focused.test', accountId: 'account-a', serverIdentityId: 'srv_action_focused' },
    ], route: () => undefined });
    const { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
    expect(getActiveServerAccountScope()).toEqual({ serverId: served.homes.focused!.id, accountId: 'account-a' });
    expect(served.homes.focused!.id).toBe('srv_action_focused');
    expect(served.homes.focused!.profileId).not.toBe(served.homes.focused!.id);
    expect(await resolveServerCredentialAccountScope(served.homes.other!.id)).toMatchObject({ kind: 'bound', scope: { accountId: 'account-other' } });
    const captured = captureActiveServerAccountScopeLifetime();
    expect(captured?.isCurrent()).toBe(true);
    await served.switchAccount('focused', 'account-b');
    expect(captured?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toEqual({ serverId: served.homes.focused!.id, accountId: 'account-b' });
    expect(await resolveServerCredentialAccountScope(served.homes.other!.id)).toMatchObject({ kind: 'bound', scope: { accountId: 'account-other' } });
    const replacement = captureActiveServerAccountScopeLifetime();
    expect(replacement?.isCurrent()).toBe(true);
    await served.dispose();
    expect(replacement?.isCurrent()).toBe(false);
    expect(getActiveServerAccountScope()).toBeNull();
});
