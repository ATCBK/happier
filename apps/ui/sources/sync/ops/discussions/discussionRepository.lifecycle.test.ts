import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, StrictMode } from 'react';
import { SessionMessageAccountActorV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';
import { createDeferred, renderHook, standardCleanup } from '@/dev/testkit';
import { createUsageNoticeArtifactFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';

// Genuine third-party render boundary, as in the shared storage-hook tests;
// this data-owner suite never renders Markdown.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getDiscussionRepository, clearDiscussionRepositoryRegistryForTests, readRegisteredDiscussionRepository } = await import('./discussionRepositoryRegistry');
const { useDiscussionListSearch } = await import('./useDiscussionListSearch');
const { getStorage } = await import('@/sync/domains/state/storageStore');

beforeEach(async () => { await homes.reset(); });
afterEach(async () => { standardCleanup(); clearDiscussionRepositoryRegistryForTests(); await homes.reset(); });

describe('shared Discussion repository Account custody', () => {
    it('starts whole-list search after Strict Effects cleanup and keeps unrelated thread updates local', async () => {
        const serverId = await homes.addHome({ name: 'Search Strict Effects', serverUrl: 'https://search-strict.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const thread = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        expect((await client.create({ creationLocalId: 'search-seed', messageLocalId: 'search-root', title: 'First topic',
            content: { v: 1, parts: [{ t: 'text', text: 'Not a search field' }] } })).kind).toBe('succeeded');
        const base = thread.stored()!.discussion;
        const sourceSession = createSessionFixture({ id: 'search-source', serverId, metadata: {
            name: 'Payment source', path: '/project', host: 'review-box',
        } });
        getStorage().getState().applySessions([sourceSession]);
        homes.answer(serverId, 'GET /v1/discussions', { select: (_input, request) => {
            const url = new URL(request.url);
            return { body: { discussions: url.searchParams.get('state') === 'archived' ? []
                : url.searchParams.has('cursor') ? [{ ...base, id: 'later-match', titleContent: { t: 'plain', v: { v: 1, title: 'Release gates' } },
                    participantAccounts: [SessionMessageAccountActorV1Schema.parse({ v: 1, accountId: 'mei-account', profile: {
                        name: 'Mei Chen', firstName: 'Mei', lastName: 'Chen', username: 'mei', avatarUrl: null,
                    } })] }, { ...base, id: 'source-match', anchor: { kind: 'session', sessionId: sourceSession.id } }] : [base],
                nextCursor: url.searchParams.get('state') === 'archived' || url.searchParams.has('cursor') ? null : 'later-page' } };
        } });
        const bindingHook = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const accountLifetime = bindingHook.getCurrent().get(serverId)!;
        const repository = getDiscussionRepository({ scope, address: { serverId }, client, accountLifetime });
        let renders = 0;
        const search = await renderHook(({ query }: { query: string }) => {
            renders += 1;
            return useDiscussionListSearch({ repository, scope, accountLifetime, query, state: 'active' });
        }, { initialProps: { query: 'release' }, wrapper: ({ children }) => createElement(StrictMode, null, children) });
        await vi.waitFor(() => expect(search.getCurrent()).toMatchObject({ status: 'ready', errorCode: null, incomplete: false, items: [{ id: 'later-match' }] }));
        await search.rerender({ query: 'Payment source' });
        expect(search.getCurrent().items.map(row => row.id)).toEqual(['source-match']);
        await act(async () => { getStorage().getState().applySessions([{ ...sourceSession, metadata: {
            ...sourceSession.metadata!, name: 'Renamed source',
        } }]); });
        expect(search.getCurrent().items).toEqual([]);
        await search.rerender({ query: 'Mei Chen' });
        expect(search.getCurrent().items.map(row => row.id)).toEqual(['later-match']);
        const reference = search.getCurrent();
        const before = renders;
        await act(async () => { await repository.refreshMessages('committed-thread'); });
        expect(search.getCurrent()).toBe(reference);
        expect(renders).toBe(before);
        await search.rerender({ query: '' });
        expect(search.getCurrent().items).toHaveLength(3);
    });

    it('never searches a foreign Doc through the current Home same-id header', async () => {
        const serverId = await homes.addHome({ name: 'Search Docs', serverUrl: 'https://search-docs.test', accountId: 'alice', currentAccount: true });
        const scope = { serverId, accountId: 'alice' };
        const thread = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
        const client = createDiscussionClient({ scope, availability: 'available' });
        await client.create({ creationLocalId: 'doc-search-seed', messageLocalId: 'doc-search-root', title: 'Discussion',
            content: { v: 1, parts: [{ t: 'text', text: 'Not searchable body' }] } });
        const base = thread.stored()!.discussion;
        const anchored = (id: string, home: string) => ({ ...base, id, anchor: { kind: 'doc', doc: {
            ref: { kind: 'doc', artifactId: 'same-doc', serverId: home }, revision: { headerVersion: 1, bodyVersion: 1 },
        } } });
        let taskOnly = false;
        homes.answer(serverId, 'GET /v1/discussions', { select: (_input, request) => ({ body: {
            discussions: new URL(request.url).searchParams.get('state') === 'archived' ? []
                : taskOnly ? [{ ...base, id: 'task-source', anchor: { kind: 'task', entry: {
                    source: { pluginId: 'com.example.tasks', localId: 'tasks' }, kindId: 'issue', collisionScope: 'project', entryId: 'opaque-id',
                } } }] : [anchored('local-doc', serverId), anchored('foreign-doc', 'other-home')], nextCursor: null,
        } }) });
        getStorage().setState({ profileScope: scope, artifacts: {
            'same-doc': createUsageNoticeArtifactFixture({ id: 'same-doc', title: 'Home-only planning', header: { kind: 'doc', title: 'Home-only planning' } }),
        } });
        const bindingHook = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
        const accountLifetime = bindingHook.getCurrent().get(serverId)!;
        const repository = getDiscussionRepository({ scope, address: { serverId }, client, accountLifetime });
        await repository.refreshList('active');
        const search = await renderHook(() => useDiscussionListSearch({ repository, scope, accountLifetime, query: 'Home-only', state: 'active' }));
        expect(search.getCurrent().items.map(row => row.id)).toEqual(['local-doc']);
        expect(search.getCurrent()).toMatchObject({ status: 'ready', incomplete: false, sourceLabelsUnavailable: true });
        await act(async () => { getStorage().setState({ profileScope: { serverId, accountId: 'other-account' } }); });
        expect(search.getCurrent().items).toEqual([]);
        expect(search.getCurrent()).toMatchObject({ status: 'ready', incomplete: false, sourceLabelsUnavailable: true });
        taskOnly = true;
        await act(async () => { await repository.refreshList('active'); });
        expect(search.getCurrent().items).toEqual([]);
        expect(search.getCurrent()).toMatchObject({ status: 'ready', incomplete: false, sourceLabelsUnavailable: true });
    });

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
