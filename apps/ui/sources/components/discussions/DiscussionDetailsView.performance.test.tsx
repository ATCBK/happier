import 'fake-indexeddb/auto';
import '@happier-dev/protocol/actions/actionApprovalPolicy';
import * as React from 'react';
import type { View as NativeView, ViewProps } from 'react-native';
import { afterEach, expect, it, vi } from 'vitest';
import { act, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { SessionMessageAccountActorV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageAccountActorV1';

const counters = vi.hoisted(() => new Map<string, ReturnType<typeof createRenderCommitCounter>>());
vi.mock('react-native', async () => {
    const React = await import('react');
    const { createRenderCommitCounter, useRenderCommitCounter } = await import('@/dev/testkit/performance/counts');
    const native = await (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock();
    // Observe real rows at the native presentation boundary; all Discussion, Markdown,
    // repository, Action and store logic remains real.
    const View = React.forwardRef<NativeView, ViewProps>((props, ref) => {
        const id = props.testID ?? '';
        const counter = React.useMemo(() => {
            const counter = createRenderCommitCounter();
            if (id.startsWith('session-discussion-message-group-')) counters.set(id, counter);
            return counter;
        }, [id]);
        useRenderCommitCounter(counter);
        return React.createElement(native.View, { ...props, ref });
    });
    return { ...native, View };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@legendapp/list/react-native', async importOriginal => {
    const { createCapturingLegendListMock } = await import('@/dev/testkit/mocks/legendList');
    // The host renderer has no measured viewport. Use the canonical native-list
    // presentation boundary (eight visible rows), retaining the real screen,
    // Markdown and data owners. No Discussion logic or row is mocked.
    return createCapturingLegendListMock({ original: await importOriginal<Record<string, unknown>>(),
        renderItemLimit: 8, memoizeItems: true }).module;
});
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: (text: string) => [{ text, reveal: false }],
}));
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { DiscussionDetailsView } = await import('./DiscussionDetailsView');
const { useDiscussionTitles } = await import('./useDiscussionTitles');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { SurfaceStateSizeProvider } = await import('@/components/ui/surfaces/surfaceStateSize');
const { createDiscussionClient } = await import('@/sync/api/discussions/discussionActions');
const { getDiscussionRepository } = await import('@/sync/ops/discussions/discussionRepositoryRegistry');
const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { sessionListRuntimeClock } = await import('@/hooks/session/sessionListRuntimeClock');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    counters.clear();
    vi.useRealTimers();
});

async function prepareLongDiscussion() {
    const serverUrl = 'https://discussion-cost.test';
    const serverIdentityId = 'srv_discussion_cost';
    const localServerId = await homes.addHome({ name: 'Discussion costs', serverUrl, serverIdentityId, accountId: 'alice', currentAccount: true });
    const serverId = resolveServerProfileScopeIdForIdentifier(localServerId);
    const features = createRootLayoutFeaturesResponse({ features: { sessions: { enabled: true, conversations: { enabled: true } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    // A settled empty Account, not a missing materialization endpoint whose
    // canonical retry lifecycle would contaminate an idle-read measurement.
    for (const path of ['/v1/plugins/availability/materializations/read', '/v1/plugins/availability/intents/list']) {
        const response = createEmptyAccountBootstrapHttpResponse(path, { method: 'POST' });
        if (!response) throw new Error(`Missing canonical Account bootstrap fixture: ${path}`);
        homes.answer(serverId, `POST ${path}`, { body: await response.json() });
    }
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    homes.answer(serverId, '/v2/cursor', { body: { cursor: 0, changesFloor: 0 } });
    homes.answer(serverId, '/v2/sessions', { body: { sessions: [], nextCursor: null, hasNext: false } });
    homes.answer(serverId, '/v2/sessions/active', { body: { sessions: [], nextCursor: null, hasNext: false } });
    homes.answer(serverId, '/v2/sessions/metadata-upgrades', { body: { sessionIds: [] } });
    homes.answer(serverId, '/v2/session-organization', { body: SessionOrganizationSnapshotResponseSchema.parse({ snapshot: {
        schemaVersion: 1, version: 0, pins: [], folders: [], folderAssignments: [], tags: [], tagAssignments: [], orderEntries: [], labels: [],
    } }) });
    const fixture = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    homes.answer(serverId, '/v1/discussions/committed-thread/participants', { body: DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'committed-thread', ownerAccountId: 'alice', access: 'owner', participants: [],
        grants: Array.from({ length: 4 }, (_, index) => ({ principal: { kind: 'account', accountId: `person-${index}` },
            accessLevel: 'edit', createdByAccountId: 'alice', createdAt: 1, display: { name: `Person ${index}`, username: null } })),
    }) });
    for (const id of ['alice', ...Array.from({ length: 4 }, (_, index) => `person-${index}`)]) {
        homes.answer(serverId, `/v1/user/${id}`, { body: { user: { id, firstName: id === 'alice' ? 'Alice' : `Person ${id.at(-1)}`,
            lastName: null, username: id, avatar: null, bio: null, status: 'none', publicKey: null } } });
    }
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId: 'alice', request: createSessionReadBatchFetchBoundary(homes.request) });
    await prepareSessionDraftPersistenceStorage();
    const scope = { serverId, accountId: 'alice' };
    const client = createDiscussionClient({ scope, availability: 'available' });
    const created = await client.create({ creationLocalId: 'cost-thread', messageLocalId: 'cost-root', title: 'Long discussion',
        content: { v: 1, parts: [{ t: 'text', text: '**Root** question' }] } });
    if (created.kind !== 'succeeded') throw new Error(JSON.stringify(created));
    const root = fixture.messages[0]!;
    let archived = false;
    const participantAccounts = ['alice', ...Array.from({ length: 4 }, (_, index) => `person-${index}`)]
        .map(accountId => SessionMessageAccountActorV1Schema.parse({ v: 1, accountId, profile: {
            name: accountId === 'alice' ? 'Alice' : `Person ${accountId.at(-1)}`,
            firstName: accountId === 'alice' ? 'Alice' : `Person ${accountId.at(-1)}`,
            lastName: null, username: accountId, avatarUrl: null,
        } }));
    const newMessage = (seq: number): typeof root => ({ ...root, id: `message-${seq}`, localId: `local-${seq}`, seq,
        authorAccountId: `person-${seq % 4}`, accountActor: { v: 1, accountId: `person-${seq % 4}`,
            profile: { name: `Person ${seq % 4}`, firstName: null, lastName: null, username: null, avatarUrl: null } },
        producerV1: seq % 100 === 0 ? { v: 1, kind: 'workflow', runId: `run-${seq / 100}`,
            invocationRecordId: `invocation-${seq}`, invocationAttempt: '0',
            execution: { kind: 'action', actionId: 'review.verdict' }, outcome: 'answer' } : null,
        content: { t: 'plain', v: { v: 1, parts: [
            { t: 'text', text: `**Answer ${seq}** with code \`value\` for ` },
            { t: 'mention', participant: { kind: 'account', accountId: 'person-0' } },
        ] } }, mentionedAccountIds: ['person-0'], createdAt: seq });
    fixture.messages.push(...Array.from({ length: 299 }, (_, index) => newMessage(index + 2)));
    // The current server's summary query already projects the admitted roster's
    // complete profiles, independently of the paged authored messages.
    homes.answer(serverId, 'GET /v1/discussions/committed-thread', { select: () => {
        const latest = fixture.messages.at(-1)!;
        const discussion = fixture.stored()!.discussion;
        return { body: { discussion: { ...discussion, participantAccounts, messageSeq: fixture.messages.length,
            archivedAt: archived ? 1 : null,
            capabilities: { ...discussion.capabilities, postMessages: !archived, archive: !archived, restore: archived },
            unreadCount: fixture.messages.length, latestMessage: { ...discussion.latestMessage,
                id: latest.id, localId: latest.localId, seq: latest.seq, authorAccountId: latest.authorAccountId,
                accountActor: latest.accountActor, producerV1: latest.producerV1, createdAt: latest.createdAt } } } };
    } });
    homes.answer(serverId, 'GET /v1/discussions/committed-thread/messages', { select: (_input, request) => {
        const after = Number(new URL(request.url).searchParams.get('afterSeq') ?? 0);
        return { body: { messages: fixture.messages.filter(row => row.seq > after), hasMoreOlder: false, messageSeq: fixture.messages.length } };
    } });
    const binding = await renderHook(() => useServerCredentialAccountScopeBindings([serverId]));
    const repository = getDiscussionRepository({ scope, address: { serverId }, client, accountLifetime: binding.getCurrent().get(serverId)! });
    return { serverId, serverUrl, fixture, newMessage, repository, setArchived: (value: boolean) => { archived = value; } };
}

it('reads a cold Discussion title without reading its 300 message bodies', async () => {
    const { serverId, repository } = await prepareLongDiscussion();
    const start = homes.requests.length;
    const address = { serverId };
    const discussionIds = ['committed-thread'];
    const titles = await renderHook(() => useDiscussionTitles({ address, discussionIds }));
    await vi.waitFor(() => expect(titles.getCurrent().get('committed-thread')).toBe('Long discussion'));
    await flushHookEffects();
    const reads = homes.requests.slice(start).filter(request => request.path.includes('/v1/discussions/'))
        .map(request => request.path);
    expect(reads.filter(path => path.includes('/messages'))).toEqual([]);
    expect(repository.getSnapshot().threads['committed-thread']?.messages ?? []).toHaveLength(0);
});

it('keeps unaffected mounted message rows quiet when one message arrives in a 300-message Discussion', async () => {
    const { serverId, serverUrl, fixture, newMessage, repository, setArchived } = await prepareLongDiscussion();
    const frame = <AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </SurfaceStateSizeProvider></AppPaneProvider>;
    const starts = homes.requests.length;
    const screen = await renderScreen(frame);
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300));
    await flushHookEffects();
    expect(counters.size).toBeGreaterThan(0);
    const routesSince = (start: number) => homes.requests.slice(start).reduce<Record<string, number>>((counts, request) => {
        const route = new URL(request.path, serverUrl).pathname;
        counts[route] = (counts[route] ?? 0) + 1;
        return counts;
    }, {});
    const cold = routesSince(starts);
    const mounted = [...counters.entries()];
    for (const [, counter] of mounted) counter.reset();
    fixture.messages.push(newMessage(301));
    await act(async () => { await repository.refreshMessages('committed-thread'); });
    await flushHookEffects();
    const counts = mounted.reduce((sum, [, counter]) => ({ renders: sum.renders + counter.read().renders,
        commits: sum.commits + counter.read().commits }), { renders: 0, commits: 0 });
    expect(screen.getTextContent()).toContain('Long discussion');
    // Empty message reads now preserve identity. Real metadata changes must still
    // reach mounted/recycled rows through the list's non-item input owner.
    expect(screen.findHostByTestId('session-discussion-reply-committed-root')).not.toBeNull();
    await act(async () => { setArchived(true); await repository.refreshSummary('committed-thread'); });
    await flushHookEffects();
    expect(screen.findHostByTestId('session-discussion-reply-committed-root') === null).toBe(true);
    await act(async () => { setArchived(false); await repository.refreshSummary('committed-thread'); });
    await flushHookEffects();
    expect(screen.findHostByTestId('session-discussion-reply-committed-root')).not.toBeNull();
    await screen.unmount();
    const warmStart = homes.requests.length;
    await renderScreen(frame);
    await flushHookEffects();
    expect(counts).toEqual({ renders: 0, commits: 0 });
});

it('advances a visible message age without rerendering its message body', async () => {
    const { serverId, fixture } = await prepareLongDiscussion();
    const now = Date.now();
    fixture.messages[0] = { ...fixture.messages[0]!, createdAt: now - 61_000 };
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const screen = await renderScreen(<AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </SurfaceStateSizeProvider></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.findHostByTestId('session-discussion-message-timestamp-committed-root')?.props.children).toBe('1m'));
    await flushHookEffects();
    const body = counters.get('session-discussion-message-group-start-committed-root');
    expect(body).toBeDefined();
    body?.reset();
    const clockFires = vi.fn();
    const unsubscribe = sessionListRuntimeClock.subscribe(clockFires);
    const idleStart = homes.requests.length;
    try {
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        const idleRequests = homes.requests.slice(idleStart).map(request => request.path);
        expect(screen.findHostByTestId('session-discussion-message-timestamp-committed-root')?.props.children).toBe('2m');
        expect(body?.read()).toEqual({ renders: 0, commits: 0 });
        expect(clockFires).toHaveBeenCalledTimes(1);
        expect(idleRequests.filter(path => path.startsWith('/v1/discussions'))).toHaveLength(0);
        await screen.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(clockFires).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
});
