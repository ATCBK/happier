import 'fake-indexeddb/auto';
import '@happier-dev/protocol/actions/actionApprovalPolicy';
import * as React from 'react';
import type { View as NativeView, ViewProps } from 'react-native';
import type { Socket } from 'socket.io-client';
import { afterEach, expect, it, vi } from 'vitest';
import { act, createDeferred, createSessionFixture, flushHookEffects, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { buildApprovalExecutionOriginV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { createArtifactListHttpResponse, createArtifactReadBatchHttpResponse, createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ArtifactReadBatchHttpInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { UpdateContainerSchema } from '@happier-dev/protocol/updates';
import { createRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { answerDiscussionThreadForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { DiscussionReadResponseV1Schema } from '@happier-dev/protocol/discussions/api';
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
const { AgentInput } = await import('@/components/sessions/agentInput');
const { publishMountedDiscussionChanges } = await import('@/sync/domains/discussions/discussionChangeWatch');
const { useWorkflowEditorAccountMemory } = await import('@/components/workflows/screens/useWorkflowEditorAccountMemory');
const { writeDiscussionSessionDraft, getSessionDraftSnapshot } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { flushSessionDraftLocally } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { DiscussionComposer } = await import('./DiscussionComposer');
const { DiscussionRouteScreen } = await import('./DiscussionRouteScreen');
const { DiscussionPhoneSurfaceHost } = await import('./DiscussionRightSidebar');
const { TranscriptListShell } = await import('@/components/sessions/transcript/viewport/shell/TranscriptListShell');
const { Modal } = await import('@/modal');
function discussionSuggestions(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const props: React.ComponentProps<typeof AgentInput> = screen.root.findByType(AgentInput).props;
    const source = props.autocompleteSuggestions;
    if (typeof source !== 'function') throw new Error('Expected the Discussion autocomplete handler');
    return (query: string, signal: AbortSignal) => source(query, signal, () => {});
}
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => {
    await standardCleanup();
    await connection?.dispose();
    connection = undefined;
    await homes.reset();
    counters.clear();
    vi.useRealTimers();
});

async function prepareLongDiscussion(configureSocket?: (socket: Socket) => void) {
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
    let roster = DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'committed-thread', ownerAccountId: 'alice', access: 'owner', participants: [],
        grants: Array.from({ length: 4 }, (_, index) => ({ principal: { kind: 'account', accountId: `person-${index}` },
            accessLevel: 'edit', createdByAccountId: 'alice', createdAt: 1, display: { name: `Person ${index}`, username: null } })),
    });
    homes.answer(serverId, '/v1/discussions/committed-thread/participants', { select: () => ({ body: roster }) });
    for (const id of ['alice', ...Array.from({ length: 4 }, (_, index) => `person-${index}`)]) {
        homes.answer(serverId, `/v1/user/${id}`, { body: { user: { id, firstName: id === 'alice' ? 'Alice' : `Person ${id.at(-1)}`,
            lastName: null, username: id, avatar: null, bio: null, status: 'none', publicKey: null } } });
    }
    connection = await restoreServerAccountForTest({ serverUrl, serverIdentityId, accountId: 'alice', configureSocket,
        request: createSessionReadBatchFetchBoundary(homes.request) });
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
    return { serverId, serverUrl, fixture, newMessage, repository, accountLifetime: binding.getCurrent().get(serverId)!,
        roster, setRoster: (value: typeof roster) => { roster = value; },
        setArchived: (value: boolean) => { archived = value; } };
}

it.each(['inventory-page', 'catch-up'] as const)('mounts a cold private Post from %s before historical approval paging settles', async arrival => {
    const sockets: Socket[] = [];
    const { serverId, repository, fixture, newMessage } = await prepareLongDiscussion(value => {
        sockets.push(value);
        configureConnectedServerSocketBoundary(value);
    });
    const sessionId = 'draft-participant';
    const question = { ...newMessage(301), content: { t: 'plain' as const, v: { v: 1 as const, parts: [
        { t: 'mention' as const, participant: { kind: 'session' as const, sessionId } },
        { t: 'text' as const, text: 'Answer the root question privately.' },
    ] } } };
    fixture.messages.push(question);
    const actionArgs = { discussionId: 'committed-thread', localId: 'original-return',
        content: { v: 1 as const, parts: [{ t: 'text' as const, text: 'A private answer' }] },
        replyTarget: { kind: 'message' as const, messageId: question.id } };
    const approval = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
        createdBy: { surface: 'agent', sessionId }, requestedSurface: 'agent', actionId: 'discussion.reply',
        actionArgs, discussionDraftReview: true, summary: 'Review the answer',
        executionOriginV1: buildApprovalExecutionOriginV1({ actionId: 'discussion.reply', input: actionArgs,
            targetSessionId: null, context: { surface: 'agent', authority: 'account_automation',
                serverId: 'daemon-local-profile', serverIdentityId: 'srv_discussion_cost', runtimeAccountId: 'alice',
                actionCaller: { kind: 'host' }, defaultSessionId: sessionId, defaultSessionMachineId: 'machine',
                actionRequestId: actionArgs.localId,
                discussionReplyReturn: { serverId: 'srv_discussion_cost', requestLocalId: 'original-input', acceptedTurnId: 'turn' } } }),
    });
    const artifactId = '11111111-1111-4111-8111-111111112919';
    const artifact = createPlainArtifactHttpFixture({ id: artifactId, header: buildApprovalRequestArtifactHeaderV1(approval),
        title: approval.summary, body: JSON.stringify(approval), isDecrypted: true,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 }, 'alice');
    const inventoryRequested = createDeferred<void>();
    const releaseInventory = createDeferred<void>();
    const bodyReads: string[][] = [];
    let changed = false;
    // A full first page makes the canonical transport continue into old receipts. A current
    // private draft must not wait for that trailing history to be read or declared complete.
    const oldRequest = ApprovalRequestV2Schema.parse({ ...approval, status: 'rejected', updatedAtMs: 2,
        executionOriginV1: { ...approval.executionOriginV1, sessionId: 'unrelated-history' },
        decision: { kind: 'reject', decidedAtMs: 2 } });
    const oldArtifact = createPlainArtifactHttpFixture({ id: '11111111-1111-4111-8111-111111112918',
        header: buildApprovalRequestArtifactHeaderV1(oldRequest), title: oldRequest.summary,
        body: JSON.stringify(oldRequest), isDecrypted: true, headerVersion: 1, bodyVersion: 1,
        seq: 1, createdAt: 1, updatedAt: 1 }, 'alice');
    const historical = Array.from({ length: 500 }, (_, index) => ({ ...oldArtifact,
        id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
        updatedAt: index + 2, seq: index + 2 }));
    const newest = { ...artifact, updatedAt: 1000, seq: 1000 };
    homes.answer(serverId, 'GET /v1/artifacts', { select: async (_body, request) => {
        const url = new URL(request.url);
        if (url.searchParams.has('cursor')) {
            inventoryRequested.resolve();
            await releaseInventory.promise;
        }
        return { body: await createArtifactListHttpResponse(url, arrival === 'inventory-page'
            ? [newest, ...historical] : historical).json() };
    } });
    homes.answer(serverId, 'POST /v1/artifacts/read', { select: async body => {
        const read = ArtifactReadBatchHttpInputV1Schema.parse(body);
        if (!('projection' in read)) bodyReads.push(read.artifactIds);
        return { body: await createArtifactReadBatchHttpResponse(body, id => id === artifactId
            ? { artifactId: id, ok: true, recipientCensus: null, artifact: newest }
            : { artifactId: id, ok: false, error: 'artifact_not_found', retryable: false, status: 404 }).json() };
    } });
    homes.answer(serverId, 'GET /v2/cursor', { select: () => ({ body: { cursor: changed ? 1 : 0, changesFloor: 0 } }) });
    homes.answer(serverId, 'GET /v2/changes', { select: (_body, request) => ({ body: { changes: changed
        && Number(new URL(request.url).searchParams.get('after') ?? 0) < 1 ? [{
        cursor: 1, kind: 'artifact', entityId: artifactId, changedAt: 1000, hint: null,
    }] : [], nextCursor: changed ? 1 : 0 } }) });
    const screen = await renderScreen(<AppPaneProvider>
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }}
            active standaloneSurface />
    </AppPaneProvider>);
    try {
        await inventoryRequested.promise;
        await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(301));
        if (arrival === 'catch-up') {
            const { storage } = await import('@/sync/domains/state/storage');
            expect(storage.getState().artifacts[artifactId]).toBeUndefined();
            changed = true;
            const receivers = sockets.filter(value => value.listeners('update').length > 0 || value.listenersAny().length > 0);
            expect(receivers.length).toBeGreaterThan(0);
            const wake = UpdateContainerSchema.parse({ id: 'approval-arrival', seq: 1,
                createdAt: 1000, body: { t: 'account-change', entityIds: [artifactId], changeKinds: ['artifact'] } });
            await act(async () => {
                for (const socket of receivers) {
                    for (const listener of socket.listenersAny()) listener('update', wake);
                    for (const listener of socket.listeners('update')) listener(wake);
                }
            });
        }
        const { storage } = await import('@/sync/domains/state/storage');
        await vi.waitFor(() => expect(storage.getState().artifacts[artifactId]?.body).toBe(JSON.stringify(approval)));
        await vi.waitFor(() => expect(screen.findHostByTestId('session-discussion-waiting-approval-approve')).not.toBeNull());
        expect(screen.findHostByTestId('session-discussion-waiting-approval-decline')).not.toBeNull();
        // The private draft reads as the answer it is, not as the Action's operands.
        expect(JSON.stringify(screen.findHostByTestId('session-discussion-waiting-approval-draft')?.props.children)).toContain('A private answer');
        // Who is waiting leads the card once the draft's Session is known; until then the generic line stands.
        await act(async () => { storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId,
            metadata: { path: '/repo', host: 'box', machineId: 'machine', flavor: 'codex', homeDir: '/home/a',
                summary: { text: 'Release bot', updatedAt: 1 } } })]); });
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('Release bot’s draft waits for you'));
        expect(storage.getState().artifactInventoryKindsLoaded).not.toContain('approval_request.v1');
        expect(bodyReads.filter(ids => ids.includes(artifactId))).toEqual([[artifactId]]);
    } finally { releaseInventory.resolve(); await screen.unmount(); }
});

it('keeps phone-covered and unfocused messages unread while the active Discussion stays live', async () => {
    const { serverId, repository, fixture, newMessage } = await prepareLongDiscussion();
    const reads: number[] = [];
    homes.answer(serverId, 'PUT /v1/discussions/committed-thread/read', { select: body => {
        if (!body || typeof body !== 'object' || !('lastReadSeq' in body) || typeof body.lastReadSeq !== 'number') {
            throw new Error('Expected canonical private read cursor');
        }
        reads.push(body.lastReadSeq);
        return { body: DiscussionReadResponseV1Schema.parse({ discussionId: 'committed-thread', lastReadSeq: body.lastReadSeq, didChange: true }) };
    } });
    const frame = (surface: 'chat' | 'participants' | 'agents' | 'details', active = true) => <AppPaneProvider>
        <DiscussionPhoneSurfaceHost surface={surface} onBackToThread={() => {}}
            main={<DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }}
                active={active} standaloneSurface />} />
    </AppPaneProvider>;
    const screen = await renderScreen(frame('chat'));
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300));
    const observe = async (seq: number) => {
        const props = screen.root.findByType(TranscriptListShell).props;
        const index = props.data.findIndex(row => row !== null && typeof row === 'object' && 'kind' in row
            && row.kind === 'human_message' && 'message' in row && row.message !== null && typeof row.message === 'object'
            && 'seq' in row.message && row.message.seq === seq);
        const item = props.data[index];
        const onViewableItemsChanged = props.onViewableItemsChanged;
        if (item === undefined || !onViewableItemsChanged) throw new Error('Expected mounted Discussion viewport row');
        // Native viewport is the only substituted boundary. Delayed/cached list
        // observations must not turn a retained, covered thread into seen content.
        const tokens = [{ item, index, key: props.keyExtractor(item, index), isViewable: true }];
        await act(async () => onViewableItemsChanged({ viewableItems: tokens, changed: tokens }));
        await flushHookEffects();
    };
    await observe(300);
    await vi.waitFor(() => expect(reads).toEqual([300]));
    for (const [index, surface] of (['participants', 'agents', 'details'] as const).entries()) {
        await act(async () => screen.update(frame(surface)));
        const seq = 301 + index;
        fixture.messages.push(newMessage(seq));
        await act(async () => { await repository.refreshDiscussion('committed-thread'); });
        expect(repository.getSnapshot().threads['committed-thread']?.messages.at(-1)?.seq).toBe(seq);
        await observe(seq);
        expect(reads).toEqual([300]);
    }
    await act(async () => screen.update(frame('chat', false)));
    await observe(303);
    expect(reads).toEqual([300]);
    await act(async () => screen.update(frame('chat')));
    await vi.waitFor(() => expect(reads).toEqual([300, 303]));
});

it('does not borrow a Home-list source refusal or write a persisted draft when New mounts', async () => {
    const { serverId, repository } = await prepareLongDiscussion();
    const scope = { serverId, accountId: 'alice' };
    const address = { kind: 'newDiscussion' as const, draftId: '00000000-0000-5000-8000-000000000007' };
    const passage = { ref: { kind: 'doc' as const, artifactId: 'private-notes', serverId },
        revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'source' };
    writeDiscussionSessionDraft({ scope, address, patch: { text: 'Retained question', passage } });
    const before = getSessionDraftSnapshot(scope, address)?.document;
    homes.answer(serverId, 'GET /v1/discussions', { status: 403, body: { error: 'discussion_access_forbidden' } });
    await repository.refreshList('active');
    const screen = await renderScreen(<AppPaneProvider><DiscussionDetailsView
        target={{ kind: 'new', address: { serverId }, draftId: address.draftId }} active /></AppPaneProvider>);
    await flushHookEffects();
    expect(getSessionDraftSnapshot(scope, address)?.document).toEqual(before);
    expect(screen.getTextContent()).not.toContain('unavailable Document passage');
});

it('gives a bare New route a fresh document while preserving the abandoned singleton', async () => {
    const { serverId } = await prepareLongDiscussion();
    const scope = { serverId, accountId: 'alice' };
    writeDiscussionSessionDraft({ scope, address: { kind: 'newDiscussion' }, patch: { text: 'An older abandoned draft' } });
    const screen = await renderScreen(<AppPaneProvider><DiscussionRouteScreen kind="new" /></AppPaneProvider>);
    await flushHookEffects();
    expect(screen.root.findByType(DiscussionDetailsView).props.target).toMatchObject({ kind: 'new',
        draftId: expect.stringMatching(/^[0-9a-f-]{36}$/i) });
    expect(screen.root.findByType(DiscussionComposer).props.value.text).toBe('');
    expect(getSessionDraftSnapshot(scope, { kind: 'newDiscussion' })?.document).toMatchObject({ composer: { text: { value: 'An older abandoned draft' } } });
});

it.each([false, true])('clears only after canonical creation and reports a device persistence failure (%s)', async failClear => {
    const { serverId } = await prepareLongDiscussion();
    const fixture = answerDiscussionThreadForTests(homes, serverId, { loseCreate: false, loseFirstRejoin: false });
    const scope = { serverId, accountId: 'alice' };
    const address = { kind: 'newDiscussion' as const, draftId: '00000000-0000-5000-8000-000000000008' };
    writeDiscussionSessionDraft({ scope, address, patch: { title: 'Creation review', text: 'A first question' } });
    await flushSessionDraftLocally({ scope });
    const onCreated = vi.fn();
    vi.mocked(Modal.alert).mockClear();
    const screen = await renderScreen(<AppPaneProvider><DiscussionDetailsView
        target={{ kind: 'new', address: { serverId }, draftId: address.draftId }} active onCreated={onCreated} /></AppPaneProvider>);
    await vi.waitFor(() => expect(screen.root.findByType(DiscussionComposer).props.disabled).toBe(false));
    expect(getSessionDraftSnapshot(scope, address)?.document).toMatchObject({ composer: { text: { value: 'A first question' } } });
    const originalPut = IDBObjectStore.prototype.put;
    let refused = false;
    // IndexedDB is the real device persistence boundary; every draft and creation owner stays real.
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
        if (failClear && fixture.stored() && typeof key === 'string' && key.startsWith('session-drafts-repository-v1:')
            && typeof value === 'string' && value.includes(address.draftId) && !value.includes('discussionMutationAttempt')) {
            refused = true;
            throw new DOMException('Device storage is full', 'QuotaExceededError');
        }
        return originalPut.call(this, value, key);
    });
    try {
        await act(async () => screen.root.findByType(DiscussionComposer).props.onSend({ v: 1, parts: [{ t: 'text', text: 'A first question' }] }));
        await vi.waitFor(() => expect(fixture.stored()).not.toBeNull());
        if (failClear) {
            await vi.waitFor(() => expect(refused).toBe(true));
            await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalled());
            expect(onCreated).not.toHaveBeenCalled();
        } else {
            await vi.waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
            expect(getSessionDraftSnapshot(scope, address)).toBeNull();
        }
    } finally {
        put.mockRestore();
        await flushSessionDraftLocally({ scope });
    }
});

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
    console.info('Discussion title reads', reads);
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
    console.info('Discussion arrival cost', { history: 300, mounted: mounted.length, ...counts });
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
    const warm = routesSince(warmStart);
    console.info('Discussion screen open reads', { cold, warm });
    expect(cold['/v1/account/project-rows/list'] ?? 0).toBe(0);
    expect(warm['/v1/account/project-rows/list'] ?? 0).toBe(0);
    expect(counts).toEqual({ renders: 0, commits: 0 });
});

it('catches up replies when a retained Discussion is reopened without a reload', async () => {
    const { serverId, serverUrl, fixture, newMessage, repository } = await prepareLongDiscussion();
    const frame = (active: boolean) => <AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active={active} />
    </SurfaceStateSizeProvider></AppPaneProvider>;
    const screen = await renderScreen(frame(true));
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300));
    await flushHookEffects();
    const mounted = [...counters.values()];
    for (const counter of mounted) counter.reset();
    const { getStorage } = await import('@/sync/domains/state/storage');
    await act(async () => { getStorage().setState({ lastSyncAt: Date.now() }); });
    expect(mounted.reduce((sum, counter) => sum + counter.read().renders, 0)).toBe(0);
    await act(async () => screen.update(frame(false)));
    await flushHookEffects();
    fixture.messages.push(newMessage(301));
    await act(async () => {
        publishMountedDiscussionChanges({ serverId, accountId: 'alice', changes: [
            { cursor: 301, kind: 'discussion', entityId: 'committed-thread', changedAt: 301, hint: null },
        ] });
        await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.summary?.messageSeq).toBe(301));
    });
    await flushHookEffects();
    // Hidden surfaces refresh summary facts only; their history remains retained.
    expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300);
    const start = homes.requests.length;
    await act(async () => screen.update(frame(true)));
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages.at(-1)?.seq).toBe(301));
    expect(homes.requests.slice(start).some(request => new URL(request.path, serverUrl).pathname
        === '/v1/discussions/committed-thread/messages')).toBe(true);
    const list = screen.root.findByType(TranscriptListShell).props;
    expect(list.data.some(row => row !== null && typeof row === 'object' && 'kind' in row
        && row.kind === 'human_message' && 'message' in row && row.message !== null
        && typeof row.message === 'object' && 'id' in row.message && row.message.id === 'message-301')).toBe(true);
});

it('keeps the workspace census demanded by real Workflow editors', async () => {
    const { accountLifetime } = await prepareLongDiscussion();
    const start = homes.requests.length;
    const memory = await renderHook(() => useWorkflowEditorAccountMemory(accountLifetime));
    await vi.waitFor(() => expect(homes.requests.slice(start).filter(request => request.path === '/v1/account/project-rows/list')).toHaveLength(1));
    await flushHookEffects();
    expect(memory.getCurrent().workspaceRefs).toEqual([]);
});

it('shares the mounted roster across queries, refreshes one invalidation, and still denies Send at the server', async () => {
    const { serverId, repository, fixture, roster, setRoster } = await prepareLongDiscussion();
    const screen = await renderScreen(<AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </SurfaceStateSizeProvider></AppPaneProvider>);
    const input = (): React.ComponentProps<typeof AgentInput> => screen.root.findByType(AgentInput).props;
    const path = '/v1/discussions/committed-thread/participants';
    await vi.waitFor(() => expect(repository.getSnapshot().threads['committed-thread']?.messages).toHaveLength(300));
    await flushHookEffects();
    const start = homes.requestsFor(path).length;
    for (const query of ['@p', '@pe', '@per', '@person']) {
        const rows = await discussionSuggestions(screen)(query, new AbortController().signal);
        expect(rows.some(row => row.label === 'Person 0')).toBe(true);
    }
    const queryReads = homes.requestsFor(path).length - start;
    setRoster({ ...roster, grants: [...roster.grants, { principal: { kind: 'account', accountId: 'new-person' },
        accessLevel: 'edit', createdByAccountId: 'alice', createdAt: 2, display: { name: 'New person', username: null } }] });
    const membershipStart = homes.requestsFor(path).length;
    await act(async () => { publishMountedDiscussionChanges({ serverId, accountId: 'alice', changes: [
        { kind: 'discussion', entityId: 'committed-thread', cursor: 1, changedAt: 2, hint: null },
    ] }); });
    await flushHookEffects();
    const membershipReads = homes.requestsFor(path).length - membershipStart;
    const afterChange = await discussionSuggestions(screen)('@new', new AbortController().signal);
    const hasNewMember = afterChange.some(row => row.label === 'New person');
    let deniedSends = 0;
    homes.answer(serverId, 'POST /v1/discussions/committed-thread/messages', { select: () => {
        deniedSends += 1;
        return { status: 403, body: { error: 'discussion_read_denied' } };
    } });
    const changeText = input().onChangeText;
    if (!changeText) throw new Error('Expected the writable Discussion input');
    await act(async () => { changeText('A stale displayed roster is not Send authority'); });
    const retainedSuggestions = discussionSuggestions(screen);
    await act(async () => { await input().onSend?.(); });
    await vi.waitFor(() => expect(deniedSends).toBe(1));
    await flushHookEffects();
    expect(repository.getSnapshot().threads['committed-thread']?.status).toBe('revoked');
    expect(repository.getSnapshot().threads['committed-thread']?.messages).toEqual([]);
    expect(fixture.messages).toHaveLength(300);
    console.info('Discussion roster cost', { queries: 4, queryReads, membershipReads, deniedSends });
    expect(await retainedSuggestions('@person', new AbortController().signal)).toEqual([]);
    expect({ queryReads, membershipReads, hasNewMember }).toEqual({ queryReads: 0, membershipReads: 1, hasNewMember: true });
});

it('retries an unavailable roster through the mounted acquisition owner, not through another query', async () => {
    const { serverId, roster } = await prepareLongDiscussion();
    const path = '/v1/discussions/committed-thread/participants';
    let unavailable = true;
    homes.answer(serverId, `GET ${path}`, { select: () => unavailable
        ? { status: 503, body: { error: 'unavailable' } } : { body: roster } });
    const screen = await renderScreen(<AppPaneProvider><SurfaceStateSizeProvider size="pane">
        <DiscussionDetailsView target={{ kind: 'discussion', address: { serverId }, discussionId: 'committed-thread' }} active />
    </SurfaceStateSizeProvider></AppPaneProvider>);
    await flushHookEffects();
    const starts = homes.requestsFor(path).length;
    const rows = await discussionSuggestions(screen)('@person', new AbortController().signal);
    const retry = rows.find(row => row.listStatus?.kind === 'retry')?.listStatus;
    expect(retry?.kind).toBe('retry');
    expect(homes.requestsFor(path)).toHaveLength(starts);
    unavailable = false;
    await act(async () => { if (retry?.kind === 'retry') retry.retry(); });
    await flushHookEffects();
    const refreshed = await discussionSuggestions(screen)('@person', new AbortController().signal);
    expect(refreshed.some(row => row.label === 'Person 0')).toBe(true);
    expect(homes.requestsFor(path)).toHaveLength(starts + 1);
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
        console.info('Discussion visible age boundary cost', { clockFires: clockFires.mock.calls.length, body: body?.read(), idleRequests });
        expect(screen.findHostByTestId('session-discussion-message-timestamp-committed-root')?.props.children).toBe('2m');
        expect(body?.read()).toEqual({ renders: 0, commits: 0 });
        expect(clockFires).toHaveBeenCalledTimes(1);
        expect(idleRequests.filter(path => path.startsWith('/v1/discussions'))).toHaveLength(0);
        await screen.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(clockFires).toHaveBeenCalledTimes(1);
    } finally { unsubscribe(); }
});
