import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
    AccountSettingsV2GetResponseSchema,
    AccountSettingsV2UpdateRequestSchema,
    AccountSettingsV2UpdateResponseSchema,
} from '@happier-dev/protocol/account/settings/accountSettingsApiV2';

import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { runtimeFetch } from '@/utils/system/runtimeFetch';

describe('served Account Settings HTTP boundary', () => {
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
        const fixture = await serveAccountHomes({
            homes: [{ key: 'encrypted', serverUrl: 'https://settings-cas-encrypted.test', accountId: 'settings-cas-encrypted-account', accountMode: 'e2ee' }],
            route: () => undefined,
        });
        try {
            const endpoint = `${fixture.homes.encrypted!.serverUrl}/v2/account/settings`;
            const { TokenStorage } = await import('@/auth/storage/tokenStorage');
            const credentials = await TokenStorage.getCredentialsForServerUrl(fixture.homes.encrypted!.serverUrl);
            expect(credentials).not.toBeNull();
            const headers = { Authorization: `Bearer ${credentials!.token}`, 'Content-Type': 'application/json' };
            expect(AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers })).json()))
                .toEqual({ content: null, version: 0 });
            // Ciphertext belongs to the client crypto owner; the server stores its opaque envelope.
            const content = { t: 'encrypted' as const, c: 'opaque-client-ciphertext' };
            const response = await runtimeFetch(endpoint, { method: 'POST', headers, body: JSON.stringify(
                AccountSettingsV2UpdateRequestSchema.parse({ content, expectedVersion: 0 }),
            ) });
            expect(AccountSettingsV2UpdateResponseSchema.parse(await response.json())).toEqual({ success: true, version: 1 });
            expect(AccountSettingsV2GetResponseSchema.parse(await (await runtimeFetch(endpoint, { headers })).json()))
                .toEqual({ content, version: 1 });
        } finally {
            await fixture.dispose();
        }
    });
});
