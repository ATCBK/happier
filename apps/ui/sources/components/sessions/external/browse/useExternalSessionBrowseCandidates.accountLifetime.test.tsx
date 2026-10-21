import { act } from 'react-test-renderer';
import { createPlainMachineReadHttpResponseFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { serveExternalSessionBrowseHome } from '@/dev/testkit/harness/externalSessionBrowseHome';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

const candidatesListSpy = vi.hoisted(() => vi.fn());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
const network = await installSessionOpsNetworkBoundary();
const { getStorage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
await import('./useExternalSessionBrowseCandidates');
function requestIdFor(payload: unknown): string {
    const request = network.socketBoundaries.flatMap(item => item.socket.emitWithAck.mock.calls)
        .map(([event, raw]) => event === SOCKET_RPC_EVENTS.CALL && raw !== null && typeof raw === 'object'
            ? raw as SocketRpcRequestPayload : null)
        .reverse().find(request => request?.params === payload);
    if (!request?.requestId) throw new Error('Expected a cancellable candidate request');
    return request.requestId;
}
function wasCancelled(requestId: string): boolean {
    return network.socketBoundaries.some(item => item.socket.emit.mock.calls.some(([event, raw]) =>
        event === SOCKET_RPC_EVENTS.CANCEL && raw !== null && typeof raw === 'object'
        && 'requestId' in raw && raw.requestId === requestId));
}
afterAll(() => network.dispose());

const params = {
    machineId: 'machine-1',
    providerId: 'codex' as const,
    source: { kind: 'codexHome' as const, home: 'user' as const },
};

/**
 * The canonical Account scope owner reads the real storage state. Driving the
 * real owner (rather than mocking it) is what makes this an Account-switch test and
 * not a restatement of the hook's own branches.
 */
let profileScope: ServerAccountScope | null = null;

describe('useExternalSessionBrowseCandidates Account lifetime', () => {
    let home: Awaited<ReturnType<typeof serveExternalSessionBrowseHome>>;
    beforeEach(async () => {
        candidatesListSpy.mockReset();
        home = await serveExternalSessionBrowseHome({ homes: [
            { key: 'foreign', serverUrl: 'https://foreign-lifetime.test', accountId: 'foreign-account' },
            { key: 'foreground', serverUrl: 'https://account-lifetime.test', accountId: 'account-a' },
        ], route: request => createPlainMachineReadHttpResponseFixture(request.path,
            { method: request.method, ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) },
            request.home === 'foreign' ? 'foreign-account' : 'account-a') ?? undefined });
        network.setRpcResponder(async call => {
            if (call.method !== RPC_METHODS.DAEMON_EXTERNAL_SESSIONS_CANDIDATES_LIST) throw new Error(`Unexpected Browse RPC ${call.method}`);
            const selected = Object.values(home.homes).find(profile => profile.serverUrl === call.serverUrl);
            if (!selected) throw new Error('Unexpected candidate Home');
            return candidatesListSpy(call.payload, { serverId: selected.id, requestId: requestIdFor(call.payload) });
        });
        const profile = home.homes.foreground!;
        profileScope = { serverId: profile.id, accountId: 'account-a' };
        getStorage().setState({ profileScope });
    });

    afterEach(async () => {
        profileScope = null;
        standardCleanup();
        await home.dispose();
    });

    it('keeps an exact foreign Home request current when the foreground Account switches', async () => {
        const foreignHome = home.homes.foreign!;
        const { useServerCredentialAccountScopes } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const scopes = await renderHook(() => useServerCredentialAccountScopes([foreignHome.id]));
        await vi.waitFor(() => expect(scopes.getCurrent().get(foreignHome.id)?.accountId).toBe('foreign-account'));
        // The credential reader loads real storage; register this boundary after that initialization.
        getStorage().setState({ profileScope });
        expect(getActiveServerAccountScope()).toEqual(profileScope);
        const accountLifetime = scopes.getCurrent().get(foreignHome.id)!;
        const inFlight = createDeferred<{ ok: true; candidates: readonly { remoteSessionId: string; updatedAtMs: number }[]; nextCursor: null }>();
        candidatesListSpy.mockImplementationOnce(() => inFlight.promise);
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const exactParams = { ...params, serverId: foreignHome.id, accountLifetime };
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(exactParams));

        profileScope = { serverId: profileScope!.serverId, accountId: 'unrelated-foreground-account' };
        getStorage().setState({ profileScope });
        await act(async () => {
            inFlight.resolve({ ok: true, candidates: [{ remoteSessionId: 'foreign-row', updatedAtMs: 1 }], nextCursor: null });
            await flushHookEffects();
        });
        expect(accountLifetime.isCurrent()).toBe(true);
        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['foreign-row']);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(true);
    });

    it('aborts a retired exact credential request and restarts for its replacement lifetime', async () => {
        const foreignHome = home.homes.foreign!;
        const { useServerCredentialAccountScopes } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const scopes = await renderHook(() => useServerCredentialAccountScopes([foreignHome.id]));
        await vi.waitFor(() => expect(scopes.getCurrent().get(foreignHome.id)?.accountId).toBe('foreign-account'));
        getStorage().setState({ profileScope });
        expect(getActiveServerAccountScope()).toEqual(profileScope);
        let accountLifetime = scopes.getCurrent().get(foreignHome.id)!;
        const oldLifetime = accountLifetime;
        const inFlight = createDeferred<{ ok: true; candidates: readonly { remoteSessionId: string; updatedAtMs: number }[]; nextCursor: null }>();
        candidatesListSpy.mockImplementationOnce(() => inFlight.promise)
            .mockResolvedValueOnce({ ok: true, candidates: [{ remoteSessionId: 'replacement-row', updatedAtMs: 2 }], nextCursor: null });
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => {
            const exactParams = { ...params, serverId: foreignHome.id, accountLifetime };
            return useExternalSessionBrowseCandidates(exactParams);
        });
        const requestId = candidatesListSpy.mock.calls[0][1].requestId as string;
        await act(async () => {
            const credentials = await TokenStorage.getCredentialsForServerUrl(foreignHome.serverUrl, { serverId: foreignHome.id });
            if (!credentials) throw new Error('Foreign Account credentials missing');
            // Re-persisting this Account credential is a genuine custody
            // mutation; its lifetime retires even when the Account stays the same.
            expect(await TokenStorage.setCredentialsForServerUrl(foreignHome.serverUrl, { serverId: foreignHome.id },
                credentials)).toBe(true);
        });
        expect(oldLifetime.isCurrent()).toBe(false);
        expect(wasCancelled(requestId)).toBe(true);
        await vi.waitFor(() => {
            const replacement = scopes.getCurrent().get(foreignHome.id);
            expect(replacement).not.toBe(oldLifetime);
            expect(replacement?.isCurrent()).toBe(true);
        });
        accountLifetime = scopes.getCurrent().get(foreignHome.id)!;
        await hook.rerender();
        await act(async () => {
            inFlight.resolve({ ok: true, candidates: [{ remoteSessionId: 'retired-row', updatedAtMs: 1 }], nextCursor: null });
            await flushHookEffects();
        });
        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId)).toEqual(['replacement-row']);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(true);
    });

    it('does not publish rows captured under one Account after a switch to another', async () => {
        const inFlight = createDeferred<{
            ok: true;
            candidates: readonly { remoteSessionId: string; title: string; updatedAtMs: number }[];
            nextCursor: string | null;
        }>();
        candidatesListSpy.mockImplementationOnce(() => inFlight.promise);
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        expect(candidatesListSpy).toHaveBeenCalledTimes(1);

        // The user switches Account while the listing request is in flight. The
        // canonical owner's scope moves; the request still carries Account A's machine.
        profileScope = { serverId: profileScope!.serverId, accountId: 'account-b' };
        getStorage().setState({ profileScope });

        await act(async () => {
            inFlight.resolve({
                ok: true,
                candidates: [{ remoteSessionId: 'account-a-only', title: 'Account A session', updatedAtMs: 1 }],
                nextCursor: 'account-a-cursor',
            });
            await flushHookEffects();
        });

        expect(hook.getCurrent().candidates).toEqual([]);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(false);
        expect(hook.getCurrent().nextCursor).toBeNull();
    });

    it('publishes rows normally while the capturing Account is still current', async () => {
        candidatesListSpy.mockResolvedValueOnce({
            ok: true,
            candidates: [{ remoteSessionId: 'same-account', title: 'Same Account session', updatedAtMs: 1 }],
            nextCursor: null,
        });
        const { useExternalSessionBrowseCandidates } = await import('./useExternalSessionBrowseCandidates');
        const hook = await renderHook(() => useExternalSessionBrowseCandidates(params));

        await flushHookEffects();

        expect(hook.getCurrent().candidates.map((candidate) => candidate.remoteSessionId))
            .toEqual(['same-account']);
        expect(hook.getCurrent().candidatesAuthoritative).toBe(true);
    });
});
