import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getDiscussionRepository, clearDiscussionRepositoryRegistryForTests, readRegisteredDiscussionRepository } = await import('./discussionRepositoryRegistry');

beforeEach(async () => { await homes.reset(); });
afterEach(async () => { standardCleanup(); clearDiscussionRepositoryRegistryForTests(); await homes.reset(); });

describe('shared Discussion repository Account custody', () => {
    it('finishes opening the selected thread when an earlier surface unmounts during its remount read', async () => {
        const serverId = await homes.addHome({ name: 'Discussion remount', serverUrl: 'https://discussion-remount.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const address = { serverId };
        const thread = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        const created = await client.create({ creationLocalId: 'remount-thread', messageLocalId: 'remount-root',
            title: 'Retained discussion', content: { v: 1, parts: [{ t: 'text', text: 'Original message' }] } });
        expect(created.kind).toBe('succeeded');
        const firstSurface = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const firstBinding = firstSurface.getCurrent().get(serverId)!;
        expect(firstBinding?.isCurrent()).toBe(true);
        const first = getDiscussionRepository({ scope, address, client, accountLifetime: firstBinding });
        await first.refreshDiscussion('committed-thread');
        expect(first.getSnapshot().threads['committed-thread']?.status).toBe('ready');

        const remountedSurface = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const remountedBinding = remountedSurface.getCurrent().get(serverId)!;
        const remounted = getDiscussionRepository({ scope, address, client, accountLifetime: remountedBinding });
        expect(remounted).toBe(first);
        const response = createDeferred<void>();
        const entered = createDeferred<void>();
        homes.answer(serverId, '/v1/discussions/committed-thread', { select: () => {
            entered.resolve();
            return { respondAfter: response.promise, body: { discussion: thread.stored()!.discussion } };
        } });
        const opening = remounted.refreshDiscussion('committed-thread');
        await entered.promise;
        await firstSurface.unmount();
        expect(firstBinding.isCurrent()).toBe(false);
        expect(remountedBinding.isCurrent()).toBe(true);
        await act(async () => { response.resolve(); await opening; });
        expect(remounted.getSnapshot().threads['committed-thread']).toMatchObject({ status: 'ready',
            summary: { id: 'committed-thread', title: 'Retained discussion' }, messages: [{ id: 'committed-root' }] });
        expect(readRegisteredDiscussionRepository(scope, address)).toBe(remounted);

        // Navigation is not Account retirement, even when all detail surfaces
        // close. A fresh mount can keep the same canonical projection and read.
        await remountedSurface.unmount();
        const freshSurface = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const freshBinding = freshSurface.getCurrent().get(serverId)!;
        expect(getDiscussionRepository({ scope, address, client, accountLifetime: freshBinding })).toBe(remounted);
        await remounted.refreshDiscussion('committed-thread');
        expect(remounted.getSnapshot().threads['committed-thread']?.status).toBe('ready');

        // A different Account has neither this cache nor permission to adopt
        // the current credential binding, even without a credential event.
        const otherScope = { serverId, accountId: 'bob' };
        const otherClient = createDiscussionClient({ scope: otherScope, availability: 'available' });
        expect(() => getDiscussionRepository({ scope: otherScope, address, client: otherClient, accountLifetime: freshBinding }))
            .toThrow('Account lifetime must match');
        const other = getDiscussionRepository({ scope: otherScope, address, client: otherClient });
        expect(other).not.toBe(remounted);
        await other.refreshDiscussion('committed-thread');
        expect(other.getSnapshot().threads['committed-thread']?.summary ?? null).toBeNull();

        // Real credential removal must still purge the shared projection and
        // prevent a response already in flight from restoring private rows.
        const staleResponse = createDeferred<void>();
        const staleEntered = createDeferred<void>();
        homes.answer(serverId, '/v1/discussions/committed-thread', { select: () => {
            staleEntered.resolve();
            return { respondAfter: staleResponse.promise, body: { discussion: thread.stored()!.discussion } };
        } });
        const staleRead = remounted.refreshDiscussion('committed-thread');
        await staleEntered.promise;
        await act(async () => { await TokenStorage.removeCredentialsForServerUrl('https://discussion-remount.test', { serverId }); });
        expect(freshBinding.isCurrent()).toBe(false);
        expect(readRegisteredDiscussionRepository(scope, address)).toBeNull();
        expect(remounted.getSnapshot().threads).toEqual({});
        await act(async () => { staleResponse.resolve(); await staleRead; });
        expect(remounted.getSnapshot().threads).toEqual({});
    });
});
