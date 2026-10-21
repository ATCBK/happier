import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { removeServerProfile, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { storage, useSetting } from '@/sync/domains/state/storage';
import {
    useServerCredentialAccountScopeBindings,
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
    it('retires current authority before notifying cancellation consumers on credential replacement', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://credential-retirement-currentness.example.test' });
        homes.push(home);
        const credentials = (accountId: string) => ({
            token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        });
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials('account-a'))).toBe(true);
        const hook = await renderHook(() => useServerCredentialAccountScopeBindings([home.id]));
        const binding = hook.getCurrent().get(home.id)!;
        expect(binding.isCurrent()).toBe(true);
        const currentDuringRetirement: boolean[] = [];
        binding.onRetire(() => { currentDuringRetirement.push(binding.isCurrent()); });
        await act(async () => {
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials('account-b'))).toBe(true);
        });
        expect(currentDuringRetirement).toEqual([false]);
        expect(binding.isCurrent()).toBe(false);
        expect(hook.getCurrent().get(home.id)?.accountId).toBe('account-b');
    });

    it('does not enqueue an empty-Home publication before an unrelated store render', async () => {
        const commits = vi.fn();
        let renders = 0;
        function Probe() {
            useServerCredentialAccountScopeBindings([]);
            useSetting('experiments');
            renders += 1;
            return null;
        }
        const screen = await renderScreen(<React.Profiler id="empty-credential-scopes" onRender={commits}><Probe /></React.Profiler>);
        const baseline = { commits: commits.mock.calls.length, renders };
        await act(async () => {
            storage.getState().applySettingsLocal({ experiments: !storage.getState().settings.experiments });
        });
        expect({ commits: commits.mock.calls.length - baseline.commits, renders: renders - baseline.renders })
            .toEqual({ commits: 1, renders: 1 });
        await screen.unmount();
    });

    it('rejects an in-flight removed Home and reselects it with a fresh credential lifetime', async () => {
        const home = await upsertServerProfile({ serverUrl: 'https://credential-inflight-selection.example.test' });
        homes.push(home);
        const credentials = (accountId: string) => ({
            token: `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`,
        });
        expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials('account-a'))).toBe(true);
        const readStarted = createDeferred<void>();
        const releaseRead = createDeferred<void>();
        const originalRead = TokenStorage.getCredentialsForServerUrl.bind(TokenStorage);
        const credentialRead = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementationOnce(async (...args) => {
            const value = await originalRead(...args);
            readStarted.resolve();
            await releaseRead.promise;
            return value;
        });
        const bindings: ServerCredentialAccountScopeBinding[] = [];
        const currentAtRemovalCommit: boolean[] = [];
        const lifecycle: ServerCredentialAccountScopeProjectionLifecycle = {
            beforeBinding: binding => { bindings.push(binding); },
        };
        try {
            const hook = await renderHook((serverIds: string[]) => {
                const resolution = useServerCredentialAccountScopeResolutions(serverIds, lifecycle);
                React.useLayoutEffect(() => {
                    if (serverIds.length === 0 && bindings.length > 0) {
                        currentAtRemovalCommit.push(bindings.at(-1)!.isCurrent());
                    }
                }, [serverIds]);
                return resolution;
            }, { initialProps: [home.id] });
            await readStarted.promise;
            expect(hook.getCurrent().get(home.id)?.kind).toBe('resolving');
            await hook.rerender([]);
            await act(async () => { releaseRead.resolve(); });
            expect(hook.getCurrent().has(home.id)).toBe(false);
            expect(bindings).toHaveLength(0);

            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, credentials('account-b'))).toBe(true);
            await hook.rerender([home.id]);
            expect(hook.getCurrent().get(home.id)).toMatchObject({ kind: 'bound', scope: { accountId: 'account-b' } });
            expect(bindings).toHaveLength(1);
            expect(bindings[0]!.isCurrent()).toBe(true);
            await hook.rerender([]);
            expect(currentAtRemovalCommit).toEqual([false]);
            expect(bindings[0]!.isCurrent()).toBe(false);
            await hook.unmount();
        } finally {
            releaseRead.resolve();
            credentialRead.mockRestore();
        }
    });

    it('retains selected Home bindings through metadata changes and still retires them on deselection and unmount', async () => {
        const selectedHomes = await Promise.all(['a', 'b', 'c'].map(async suffix => {
            const home = await upsertServerProfile({ serverUrl: `https://credential-selection-${suffix}.example.test` });
            homes.push(home);
            expect(await TokenStorage.setCredentialsForServerUrl(home.serverUrl, { serverId: home.id }, {
                token: `e30.${Buffer.from(JSON.stringify({ sub: `account-${suffix}` })).toString('base64url')}.signature`,
            })).toBe(true);
            return home;
        }));
        const [homeA, homeB, homeC] = selectedHomes;
        const bindings = new Map<string, ServerCredentialAccountScopeBinding>();
        const lifecycle: ServerCredentialAccountScopeProjectionLifecycle = {
            beforeBinding: binding => { bindings.set(binding.serverId, binding); },
        };
        const hook = await renderHook((serverIds: string[]) => useServerCredentialAccountScopeResolutions(serverIds, lifecycle), {
            initialProps: [homeA!.id, homeB!.id],
        });
        const bindingA = bindings.get(homeA!.id)!;
        const bindingB = bindings.get(homeB!.id)!;
        let retiredA = 0;
        let retiredB = 0;
        bindingA.onRetire(() => { retiredA += 1; });
        bindingB.onRetire(() => { retiredB += 1; });

        await hook.rerender([homeA!.id, homeC!.id]);
        expect(bindings.get(homeA!.id)).toBe(bindingA);
        expect(bindingA.isCurrent()).toBe(true);
        expect(retiredA).toBe(0);
        expect(bindingB.isCurrent()).toBe(false);
        expect(retiredB).toBe(1);
        expect(hook.getCurrent().has(homeB!.id)).toBe(false);

        await act(async () => {
            await upsertServerProfile({ serverUrl: homeA!.serverUrl, name: 'Changed Home label' });
        });
        expect(bindingA.isCurrent()).toBe(true);
        expect(retiredA).toBe(0);
        const currentA = bindings.get(homeA!.id)!;
        const currentC = bindings.get(homeC!.id)!;
        expect(currentA).toBe(bindingA);
        expect(currentA.isCurrent()).toBe(true);
        let retiredCurrentA = 0;
        currentA.onRetire(() => { retiredCurrentA += 1; });
        await hook.unmount();
        expect(currentA.isCurrent()).toBe(false);
        expect(currentC.isCurrent()).toBe(false);
        expect(retiredCurrentA).toBe(1);
    });

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
            // These projections share the real store with the draft screens.
            // Include that subscription, not just the callback's store write.
            useSetting('experiments');
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
        const beforeStoreUpdate = renders;
        await act(async () => {
            storage.getState().applySettingsLocal({ experiments: !storage.getState().settings.experiments });
        });
        expect(renders - beforeStoreUpdate).toBe(1);
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
