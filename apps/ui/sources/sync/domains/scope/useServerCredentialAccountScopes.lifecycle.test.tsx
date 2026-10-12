import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storage';
import {
    useServerCredentialAccountScopeResolutions,
    type ServerCredentialAccountScopeBinding,
    type ServerCredentialAccountScopeProjectionLifecycle,
} from './useServerCredentialAccountScopes';

const homes: Array<Readonly<{ id: string; serverUrl: string }>> = [];

afterEach(async () => {
    standardCleanup();
    for (const home of homes.splice(0)) {
        await TokenStorage.removeCredentialsForServerUrl(home.serverUrl, { serverId: home.id });
        await removeServerProfile(home.id);
    }
    storage.setState(storage.getInitialState(), true);
});

describe('credential projection lifecycle identity', () => {
    it.each(['bound', 'signed_out'] as const)('settles a %s Home with fresh lifecycle callbacks on every render', async (state) => {
        const home = await upsertServerProfile({ serverUrl: `https://credential-inline-${state}.example.test` });
        homes.push(home);
        if (state === 'bound') {
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
                token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-inline' })).toString('base64url')}.signature`,
            })).toBe(true);
        }
        let renders = 0;
        const hook = await renderHook(() => {
            // Test-only escape from the known feedback loop: fail instead of hanging the runner.
            if (++renders > 64) throw new Error('credential projection keeps rendering instead of settling');
            return useServerCredentialAccountScopeResolutions([home.id], {
                beforeBinding: (binding) => storage.getState().activateProfileScope(binding.scope),
            });
        });
        expect(hook.getCurrent().get(home.id)?.kind).toBe(state);
        const settled = hook.getCurrent().get(home.id);
        await hook.rerender();
        expect(hook.getCurrent().get(home.id)).toBe(settled);
        if (state === 'bound') expect(storage.getState().profileScope?.accountId).toBe('account-inline');
        await hook.unmount();
    });

    it('keeps the credential lifetime across callback replacement and uses the latest callbacks on mutation', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://credential-lifecycle.example.test' });
        homes.push(home);
        const credentials = (accountId: string) => ({
            token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        });
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials('account-a'))).toBe(true);
        const initialBindings: ServerCredentialAccountScopeBinding[] = [];
        const nextBindings: ServerCredentialAccountScopeBinding[] = [];
        const mutations: string[] = [];
        const initialLifecycle: ServerCredentialAccountScopeProjectionLifecycle = {
            beforeBinding: (binding) => initialBindings.push(binding),
        };
        const hook = await renderHook((lifecycle: ServerCredentialAccountScopeProjectionLifecycle) =>
            useServerCredentialAccountScopeResolutions([home.id], lifecycle), { initialProps: initialLifecycle });
        expect(hook.getCurrent().get(home.id)).toMatchObject({ kind: 'bound', scope: { accountId: 'account-a' } });
        const binding = initialBindings[0]!;
        const resolution = hook.getCurrent().get(home.id);
        let retired = false;
        binding.onRetire(() => { retired = true; });

        await hook.rerender(initialLifecycle);
        expect(binding.isCurrent()).toBe(true);
        expect(hook.getCurrent().get(home.id)).toBe(resolution);

        await hook.rerender({
            beforeBinding: (next) => nextBindings.push(next),
            onCredentialMutation: (serverId) => mutations.push(serverId),
        });
        expect(binding.isCurrent()).toBe(true);
        expect(retired).toBe(false);
        expect(hook.getCurrent().get(home.id)).toBe(resolution);

        await act(async () => {
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials('account-b'))).toBe(true);
        });
        expect(binding.isCurrent()).toBe(false);
        expect(retired).toBe(true);
        expect(mutations).toEqual([home.id]);
        expect(nextBindings.map((next) => next.accountId)).toEqual(['account-b']);
        expect(hook.getCurrent().get(home.id)).toMatchObject({ kind: 'bound', scope: { accountId: 'account-b' } });
        await hook.unmount();
    });
});
