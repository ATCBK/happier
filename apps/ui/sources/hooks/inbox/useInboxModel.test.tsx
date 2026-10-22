import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { SetSessionAttentionStandingRequestSchema, SetSessionAttentionStandingResponseSchema } from '@happier-dev/protocol/sessions/organization/standings';
import { SessionReadStateSetResultV1Schema } from '@happier-dev/protocol/sessions/readState/actions';

import { createDeferred, createPlainAccountEncryptionCurrentnessFixture, createSessionFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { buildSessionOrganizationSessionKey } from '@/sync/domains/session/organization/keys';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, FeaturesResponseSchema, compilePluginJsonSchema, encodePlainArtifactStoredContent,
    encodePluginCollectionLogicalValueV1, isValidPluginJsonSchemaValue,
    normalizePluginAccountCollectionContractV1, PluginAccountCollectionContributionV1Schema } from '@happier-dev/protocol';
import { ConversationBindingV1Schema } from '@happier-dev/channels-protocol/v1';
import { deriveArtifactCoarseKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { clearPluginAccountAvailabilityProjection, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { resetActivePluginCollectionChanges } from '@/sync/api/plugins/data/pluginCollectionChangeWatch';
import { recordAccountStoredContentServerRequirements } from '@/sync/http/accountStoredContentCompatibility';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { invokeMountedWorkRead } from '@/sync/ops/actions/mountedWorkReadAction';
import { deleteServerFeaturesSnapshot, primeServerFeaturesSnapshot } from '@/sync/api/capabilities/serverFeaturesClient';
import { createAutomationRunFixture, createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { storage } from '@/sync/domains/state/storageStore';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { WorkflowRunListPage } from '@/sync/domains/workflows/workflowRunListActions';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useSessionManagedWorkflowRuns, type SessionManagedWorkflowRunsState } from '@/components/workflows/run/useContextManagedWorkflowRuns';
import { projectWork, resolveWorkReadPresentation } from '@/components/sessions/work/workProjection';
import type { DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';
import { createAccountNoticeArtifactFixture, createUsageNoticeArtifactFixture, usageNoticeFixture } from '@/dev/testkit/fixtures/usageNoticeFixtures';
import { AutomationDefinitionListItemSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { createAutomationDefinitionSummary } from '@/sync/domains/automations/automationDefinitionProjection';
import { buildVoiceBrief, type VoiceBriefItem } from '@/voice/context/buildVoiceBrief';
import { VoiceBriefList } from '@/components/voice/brief/VoiceBrief';
import { Item } from '@/components/ui/lists/Item';
import { DiscussionSummaryV1Schema, DiscussionMessageV1Schema } from '@happier-dev/protocol/discussions/models';
import { DiscussionReadResponseV1Schema } from '@happier-dev/protocol/discussions/api';
import { readRegisteredDiscussionRepository } from '@/sync/ops/discussions/discussionRepositoryRegistry';

import { InboxModelProvider, useInboxModel, type InboxModel } from './useInboxModel';
import { useInboxDiscussionSource } from './useInboxDiscussionSource';
import { AppShellPluginUiProjectionValueProvider, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { InboxSummaryProvider, useSharedInboxSummary, type InboxSummary } from './useInboxSummary';
import { countInbox, countInboxNeedsYou } from '@/components/inbox/inboxCounts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The Inbox model groups by work root over the real classifier and the real workflow window.
 * Only HTTP, Socket.IO and device credentials are boundaries; the Action front door stays real.
 */
const listRuns = vi.hoisted(() => vi.fn<(params: { filter?: Record<string, unknown> }) => Promise<WorkflowRunListPage>>());
const executed = vi.hoisted(() => [] as Array<{ actionId: string; input: unknown }>);
const automationBoundary = vi.hoisted(() => ({ request: vi.fn() }));
const collectionBoundary = vi.hoisted(() => ({ request: vi.fn() }));
const discussionBoundary = vi.hoisted(() => ({ request: vi.fn() }));
const artifactReadBoundary = vi.hoisted(() => ({ request: vi.fn() }));
let appliedSnapshot: typeof import('@/sync/domains/server/serverRuntime')['getActiveServerSnapshot'];
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let disposeActionLoader: (() => void) | undefined;
installDisconnectedServerSocketBoundary();
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

function page(runs: ReturnType<typeof createWorkflowRunSummaryFixture>[]): WorkflowRunListPage {
    return { runs, metadataByRunId: {}, nextCursor: undefined };
}

let model: InboxModel | null = null;
const readExecutor = createActionExecutor(createActionExecutorBoundaryFixture({ appShellAction: invokeMountedWorkRead }));
function readInbox(accountId = 'account-a') {
    return readExecutor.execute('inbox.get', {}, { surface: 'agent', authority: 'account_automation',
        serverId: appliedSnapshot().serverId, runtimeAccountId: accountId });
}
function Probe(): null {
    model = useInboxModel();
    return null;
}

function BriefRows(props: Readonly<{ onOpen: (item: VoiceBriefItem) => void }>) {
    const inbox = useInboxModel();
    const brief = buildVoiceBrief({ inbox, settings: storage.getState().settings });
    return <VoiceBriefList brief={brief} onOpen={props.onOpen} />;
}

async function renderModel(children?: React.ReactNode) {
    const screen = await renderScreen(<InboxModelProvider><Probe />{children}</InboxModelProvider>);
    await act(async () => {});
    return screen;
}

function enableDiscussionReads() {
    const base = createRootLayoutFeaturesResponse();
    const features = FeaturesResponseSchema.parse({ ...base, features: { ...base.features,
        sharing: { ...base.features.sharing, session: { enabled: true } },
        sessions: { ...base.features.sessions, conversations: { enabled: true } } } });
    primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features } });
}

describe('useInboxModel work groups (ORC R-10)', () => {
    beforeAll(async () => {
        await loadSyncSingletonForTests();
        disposeActionLoader = await installRealActionExecutorModuleLoader();
    });
    afterAll(() => disposeActionLoader?.());
    beforeEach(async () => {
        clearPluginAccountAvailabilityProjection();
        const runtime = await import('@/sync/domains/server/serverRuntime');
        appliedSnapshot = runtime.getActiveServerSnapshot;
        (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        model = null;
        executed.length = 0;
        listRuns.mockReset();
        automationBoundary.request.mockReset();
        collectionBoundary.request.mockReset().mockResolvedValue(null);
        discussionBoundary.request.mockReset().mockResolvedValue(null);
        artifactReadBoundary.request.mockReset().mockResolvedValue(null);
        automationBoundary.request.mockImplementation(async () => new Response(JSON.stringify({ runs: [], nextCursor: null }), { status: 200 }));
        const base = createRootLayoutFeaturesResponse();
        const features = FeaturesResponseSchema.parse({
            ...base, features: { ...base.features, workflows: { enabled: true }, automations: { ...base.features.automations, enabled: true },
                social: { ...base.features.social, friends: { enabled: false } } },
        });
        connection = await restoreServerAccountForTest({ serverUrl: 'http://inbox-home.test', accountId: 'account-a', request: async (url, init) => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {
                experiments: true, featureToggles: { automations: true },
            } }, version: 1 });
            if (path === '/v3/automations/runs') return automationBoundary.request(url, init);
            if (path === '/v3/automations/runs/workflow-storage') {
                const body = JSON.parse(String(init?.body)) as { request: Record<string, unknown> };
                const result = await listRuns({ filter: body.request });
                return Response.json({ runs: result.runs, acceptedEnvelopesByRunId: {}, keyCensusByRunId: {}, nextCursor: result.nextCursor });
            }
            if (path.startsWith('/v2/session-organization/attention-standings/')) {
                const sessionId = decodeURIComponent(path.split('/').at(-1)!);
                const request = SetSessionAttentionStandingRequestSchema.parse(JSON.parse(String(init?.body)));
                executed.push({ actionId: 'session.attention.set', input: { sessionId, ...request } });
                return Response.json(SetSessionAttentionStandingResponseSchema.parse({ standing:
                    request.standing === null || request.remindAt === null ? null : {
                        sessionId, standing: request.standing ?? false, updatedAt: 1,
                        ...(typeof request.remindAt === 'number' ? { remindAt: request.remindAt } : {}),
                    },
                }));
            }
            if (path.endsWith('/read-state')) {
                const sessionId = decodeURIComponent(path.split('/').at(-2)!);
                const request = JSON.parse(String(init?.body)) as { state: 'read' | 'unread' };
                executed.push({ actionId: 'session.read_state.set', input: { sessionId, ...request } });
                return Response.json({ success: true, ...SessionReadStateSetResultV1Schema.parse({
                    state: request.state, lastViewedSessionSeq: 1, didChange: true,
                }) });
            }
            if (path.startsWith('/v1/plugins/data')) return collectionBoundary.request(path, init);
            if (path.startsWith('/v1/discussions')) return discussionBoundary.request(path, init);
            if (path === '/v1/artifacts/read') return artifactReadBoundary.request(path, init);
            return null;
        } });
        publishAppliedActiveServerSnapshot(appliedSnapshot());
        primeServerFeaturesSnapshot({ snapshot: { status: 'ready', features } });
        storage.setState({
            settings: { ...storage.getState().settings, experiments: true, featureToggles: { ...storage.getState().settings.featureToggles, automations: true } },
            profileScope: { serverId: runtime.getActiveServerSnapshot().serverId, accountId: 'account-a' },
            friends: {},
            sessions: {},
            sessionListRowsByServerId: {},
            ordinarySessionListMembershipByServerId: {},
            artifacts: {},
            automations: {},
            isDataReady: true,
            workflowRunsById: {},
            workflowRunListWindows: {},
            sessionOrganizationAttentionStandingsBySessionKey: {},
        } as never);
    });

    afterEach(async () => {
        standardCleanup();
        await connection?.dispose();
        connection = undefined;
        clearPluginAccountAvailabilityProjection();
        deleteServerFeaturesSnapshot();
        (await import('@/components/workflows/library/workflowLibraryReads')).resetWorkflowLibraryReadsForTests();
        (await import('@/sync/domains/scope/activeServerAccountScope')).retireActiveServerAccountScopeLifetime();
    });

    it.each(['retirement', 'unmount'] as const)('quietly cancels an Inbox Discussion refresh on %s', async reason => {
        enableDiscussionReads();
        const started = createDeferred<AbortSignal>();
        discussionBoundary.request.mockImplementation((_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) throw new Error('Expected a cancellable Discussion read');
            started.resolve(signal);
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }));
        const unhandled: unknown[] = [];
        const recordUnhandled = (error: unknown) => { unhandled.push(error); };
        process.on('unhandledRejection', recordUnhandled);
        try {
            const serverId = appliedSnapshot().serverId;
            const hook = await renderHook(() => useInboxDiscussionSource(serverId));
            const signal = await started.promise;
            if (reason === 'unmount') await hook.unmount();
            else await act(async () => {
                const server = appliedSnapshot();
                await TokenStorage.removeCredentialsForServerUrl(server.serverUrl, { serverId });
            });
            expect(signal.aborted).toBe(true);
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(unhandled).toEqual([]);
            if (reason === 'retirement') expect(hook.getCurrent().source).toBeNull();
        } finally {
            process.removeListener('unhandledRejection', recordUnhandled);
        }
    });

    it('keeps a refused Inbox Discussion refresh visible through its source state', async () => {
        enableDiscussionReads();
        discussionBoundary.request.mockResolvedValue(Response.json({ error: 'discussion_read_denied' }, { status: 403 }));
        const hook = await renderHook(() => useInboxDiscussionSource(appliedSnapshot().serverId));
        await expect.poll(() => hook.getCurrent().errorCode).toBe('discussion_read_denied');
        expect(hook.getCurrent().status).toBe('revoked');
        expect(hook.getCurrent().coverage).toBe('partial');
    });

    it.each(['mention', 'decision'] as const)('keeps the unopened badge and opened %s row in agreement until its owner settles it', async type => {
        listRuns.mockResolvedValue(page([]));
        let lastReadSeq = 0;
        let proposalOpen = true;
        const message = DiscussionMessageV1Schema.parse({ id: 'mention-1', discussionId: 'doc-comments', localId: null,
            seq: 1, authorAccountId: null, accountActor: null, producerV1: { v: 1, kind: 'agent', sessionId: 'inbox-bot' },
            content: { t: 'plain', v: type === 'decision' ? { kind: 'doc_edit_proposal', proposal: {
                target: { ref: { kind: 'doc', artifactId: 'plan', serverId: appliedSnapshot().serverId },
                    revision: { headerVersion: 1, bodyVersion: 1 }, range: { start: 0, end: 6 }, quote: 'Before' },
                baseRevision: { headerVersion: 1, bodyVersion: 1 }, before: 'Before', after: 'After', reason: 'Clarify',
            } } : { v: 1, parts: [{ t: 'text', text: 'Review this passage' }] } },
            mentionedAccountIds: ['account-a'], createdAt: 1 });
        const summary = () => DiscussionSummaryV1Schema.parse({ id: 'doc-comments', ownerAccountId: 'account-a', encryptionMode: 'plain',
            anchor: { kind: 'doc', doc: { ref: { kind: 'doc', artifactId: 'plan', serverId: appliedSnapshot().serverId },
                revision: { headerVersion: 1, bodyVersion: 1 } } }, access: 'owner', keyReadiness: true, dataEncryptionKey: null,
            creationLocalId: null, titleContent: { t: 'plain', v: { v: 1, title: 'Plan comments' } },
            latestMessage: { id: message.id, localId: null, seq: 1, authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1 },
            messageSeq: 1, lastReadSeq, unreadCount: 1 - lastReadSeq, unreadMentionCount: 1 - lastReadSeq,
            recentAuthorAccountIds: [], archivedAt: null, capabilities: { postMessages: true, rename: true, archive: true,
                restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } });
        discussionBoundary.request.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/discussions/attention') return Response.json({ discussions: (type === 'decision' ? proposalOpen : lastReadSeq === 0)
                ? [{ discussion: summary(), occurrences: [{ message, type }] }] : [], nextCursor: null, incomplete: false });
            if (path === '/v1/discussions') return Response.json({ discussions: [summary()], nextCursor: null });
            if (path === '/v1/discussions/doc-comments') return Response.json({ discussion: summary() });
            if (path === '/v1/discussions/doc-comments/messages') return Response.json({ messages: [message], hasMoreOlder: false, messageSeq: 1 });
            if (path === '/v1/discussions/doc-comments/read') {
                const body = JSON.parse(String(init?.body)) as { lastReadSeq: number };
                lastReadSeq = body.lastReadSeq;
                return Response.json(DiscussionReadResponseV1Schema.parse({ discussionId: 'doc-comments', lastReadSeq, didChange: true }));
            }
            return null;
        });
        enableDiscussionReads();
        const bot = createSessionFixture({ id: 'inbox-bot', serverId: appliedSnapshot().serverId,
            metadata: { name: 'Payments coordinator', path: '/work/payments', host: 'machine' } });
        storage.setState({ sessions: { [bot.id]: bot } });
        let badge: InboxSummary | null = null;
        function Badge() { badge = useSharedInboxSummary(); return null; }
        const chrome = await renderScreen(<InboxSummaryProvider><Badge /></InboxSummaryProvider>);
        await vi.waitFor(() => expect(badge).toEqual({ count: 1, hasContent: true }));
        const stableBadge = badge;
        await act(async () => { storage.setState({ friends: {} }); });
        expect(badge).toBe(stableBadge);
        const screen = await renderModel();
        const scope = storage.getState().profileScope!;
        await vi.waitFor(() => expect(model!.discussionAttention.source?.entries).toHaveLength(1));
        const repository = readRegisteredDiscussionRepository(scope, { serverId: scope.serverId });
        expect(repository).not.toBeNull();
        await vi.waitFor(() => expect(model!.items.some(item => item.source.kind === 'discussion')).toBe(true));
        expect(repository!.getSnapshot().threads).toEqual({});
        expect(discussionBoundary.request.mock.calls.filter(([path]) => path.includes('/messages'))).toEqual([]);
        const row = model!.items.find(item => item.source.kind === 'discussion');
        expect(row).toMatchObject({ type, view: type === 'decision' ? 'needs_you' : 'mentions', read: false,
            pageRoute: `/discussions/doc-comments?serverId=${encodeURIComponent(scope.serverId)}&messageId=mention-1`,
            focus: { kind: 'discussion', serverId: scope.serverId,
            id: 'doc-comments', messageId: 'mention-1' }, discussion: { anchor: summary().anchor },
            source: { displayName: 'Plan comments' }, author: { name: 'Payments coordinator' } });
        expect(countInbox(model!)).toBe(1);
        expect(countInboxNeedsYou(model!)).toBe(type === 'decision' ? 1 : 0);
        expect(model!.discussionAttention.coverage).toBe('complete');
        await act(async () => { storage.setState({ sessions: { [bot.id]: { ...bot, encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_content_unavailable' } } }); });
        expect(model!.items.find(item => item.source.kind === 'discussion')?.author).toBeNull();
        await act(async () => { await model!.markItemOpened(row!); });
        if (type === 'decision') {
            // Opening Needs you never marks it read. The Discussion's own visible-read
            // owner may advance its cursor, but that is still not proposal disposition.
            expect(lastReadSeq).toBe(0);
            await act(async () => { await model!.discussionAttention.markOpened(row!); });
            expect(lastReadSeq).toBe(1);
            expect(model!.items.find(item => item.source.kind === 'discussion')).toMatchObject({ read: true, view: 'needs_you' });
            expect(countInboxNeedsYou(model!)).toBe(1);
            expect(badge).toEqual({ count: 1, hasContent: true });
            proposalOpen = false;
            await act(async () => { await repository!.refreshAttention(); });
        } else expect(lastReadSeq).toBe(1);
        expect(model!.items.filter(item => item.source.kind === 'discussion')).toEqual([]);
        expect(countInbox(model!)).toBe(0);
        expect(badge).toEqual({ count: 0, hasContent: false });
        expect(executed.filter(item => item.actionId === 'session.read_state.set')).toEqual([]);
        await screen.unmount();
        await chrome.unmount();
    });

    it('names the loaded exact-Home approval requester and keeps wrong-Home or locked names unavailable', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const bot = createSessionFixture({ id: 'approval-bot', serverId,
            metadata: { name: 'Payments coordinator', path: '/work/payments', host: 'machine' } });
        const request = ApprovalRequestV2Schema.parse({ v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1,
            createdBy: { surface: 'cli', sessionId: bot.id }, actionId: 'account.name.set', actionArgs: { name: 'Captain' }, summary: 'Change name',
            executionOriginV1: { v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' },
                sessionId: bot.id, serverId, actionId: 'account.name.set', requestId: 'approval-source' } });
        const artifact: DecryptedArtifact = { id: 'approval-source', isDecrypted: true, title: request.summary,
            header: buildApprovalRequestArtifactHeaderV1(request), body: JSON.stringify(request),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        storage.setState({ sessions: { [bot.id]: bot }, artifacts: { [artifact.id]: artifact } });
        const screen = await renderModel();
        expect(model!.items.find(item => item.source.kind === 'approval')?.source.displayName).toBe('Payments coordinator');
        await act(async () => { storage.setState({ sessions: { [bot.id]: { ...bot, serverId: 'another-home' } } }); });
        expect(model!.items.find(item => item.source.kind === 'approval')?.source.displayName).toBeNull();
        await act(async () => { storage.setState({ sessions: { [bot.id]: { ...bot, encryptionMode: 'e2ee',
            encryptedContentAvailability: 'encrypted_content_unavailable' } } }); });
        expect(model!.items.find(item => item.source.kind === 'approval')?.source.displayName).toBeNull();
        await screen.unmount();
    });

    it('hydrates a header-only managed Delete Ask and lists it exactly once', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const request = ApprovalRequestV2Schema.parse({
            v: 2, status: 'open', createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' }, requestedSurface: 'ui',
            actionId: 'machines.managed.delete',
            actionArgs: { homeId: serverId, managedId: 'managed-a', when: 'now', expectedRevision: 3,
                intent: 'delete', reviewedDependencies: true },
            summary: 'Delete managed machine',
            executionOriginV1: { v: 1, authority: 'present_user', surface: 'ui', caller: { kind: 'host' },
                serverId, accountId: 'account-a', machineId: 'controller-a', target: { kind: 'machine', machineId: 'controller-a' },
                actionId: 'machines.managed.delete', requestId: 'delete-request' },
        });
        const header = buildApprovalRequestArtifactHeaderV1(request);
        const artifact: DecryptedArtifact = { id: 'delete-ask', isDecrypted: true, title: request.summary, header,
            body: undefined, headerVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        storage.setState({ artifacts: { [artifact.id]: artifact } });
        artifactReadBoundary.request.mockImplementation(async (_path: string, init?: RequestInit) => {
            expect(JSON.parse(String(init?.body))).toEqual({ artifactIds: [artifact.id] });
            return Response.json({ items: [{ artifactId: artifact.id, ok: true, recipientCensus: null, artifact: {
                id: artifact.id, kind: deriveArtifactCoarseKindV1(header), ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'plain',
                publicAudience: 'none', dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
                header: encodePlainArtifactStoredContent(header),
                body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            } }] });
        });
        const screen = await renderModel();
        await expect.poll(() => model?.openApprovals.map(row => row.id)).toEqual([artifact.id]);
        expect(model?.items.filter(item => item.source.kind === 'approval')).toHaveLength(1);
        expect(artifactReadBoundary.request).toHaveBeenCalledTimes(1);
        await screen.unmount();
    });

    it('names plugin notices from the existing Account-scoped package projection and withdraws unavailable names', async () => {
        listRuns.mockResolvedValue(page([]));
        const notice = createAccountNoticeArtifactFixture({ header: { body: 'Review the change' } });
        storage.setState({ artifacts: { [notice.id]: notice } });
        const value: AppShellPluginUiProjectionValue = {
            pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, installedPackagesById: { 'acme.review': {
                id: 'acme.review', displayName: 'Acme Review', version: '1.0.0', enabled: true,
                source: { kind: 'bundled', locator: '@acme/review' },
            } } }, pluginBrowserProjection: null, phase: 'current', interactionEnabled: true, machineId: null,
            serverId: appliedSnapshot().serverId, platform: 'web', accountLifetime: captureActiveServerAccountScopeLifetime(),
            reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'ready' }, reloadClientExecutables: () => {},
        };
        const render = (next: AppShellPluginUiProjectionValue) => <AppShellPluginUiProjectionValueProvider value={next}>
            <InboxModelProvider><Probe /></InboxModelProvider>
        </AppShellPluginUiProjectionValueProvider>;
        const screen = await renderScreen(render(value));
        expect(model!.items[0]).toMatchObject({ source: { displayName: 'Acme Review' }, author: null, excerpt: 'Review the change' });
        await screen.update(render({ ...value, accountLifetime: null }));
        expect(model!.items[0]?.source.displayName).toBeNull();
        await screen.unmount();
    });

    it('projects only current Account-owned readable open usage notices without creating Sessions', async () => {
        listRuns.mockResolvedValue(page([]));
        const notice = usageNoticeFixture;
        const owned = createUsageNoticeArtifactFixture();
        const rows: DecryptedArtifact[] = [owned,
            { ...owned, id: 'foreign', ownerAccountId: 'account-b' },
            { ...owned, id: 'shared', access: 'view' },
            { ...owned, id: 'published', publicAudience: 'retained' },
            { ...owned, id: 'unknown-audience', publicAudience: 'unknown' },
            createUsageNoticeArtifactFixture({ id: 'dismissed', header: { ...owned.header!, status: 'dismissed' }, body: undefined }),
            createUsageNoticeArtifactFixture({ id: 'invalid', header: { ...owned.header!, notice: { ...notice, evidence: {} } }, body: undefined }),
            createUsageNoticeArtifactFixture({ id: 'body-mismatch', body: JSON.stringify({ v: 1, notice: { ...notice, issueFingerprint: 'other' } }) }),
            createUsageNoticeArtifactFixture({ id: 'header-only', body: undefined }),
            { ...owned, id: 'locked', isDecrypted: false, title: null, header: null,
                rawHeader: null, body: undefined, sessions: undefined, draft: undefined,
                storageMode: 'e2ee', availability: { kind: 'locked', reason: 'decryption_failed' } },
        ];
        storage.setState({ artifacts: Object.fromEntries(rows.map(row => [row.id, row])) });

        await renderModel();

        expect(model).toMatchObject({ openUsageNotices: [{ artifact: owned, header: owned.header }],
            hasPrimaryAttention: true, showCaughtUp: false });
        expect(model?.workGroups).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'ready', usageNoticeIds: ['notice-owned'] } });

        await act(async () => { storage.setState({ artifacts: {
            ...storage.getState().artifacts,
            'header-only': createUsageNoticeArtifactFixture({ id: 'header-only' }),
        } }); });
        expect(model?.openUsageNotices.map(entry => entry.artifact.id)).toEqual(['notice-owned', 'header-only']);

        await act(async () => { storage.setState({ profileScope: {
            ...storage.getState().profileScope!, accountId: 'account-b',
        } }); });
        expect(model).toMatchObject({ openUsageNotices: [{ artifact: rows[1] }], hasPrimaryAttention: true });
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
        expect(await readInbox('account-b')).toMatchObject({ ok: true, result: { status: 'ready', usageNoticeIds: ['foreign'] } });
    });

    it('reads started and recovered machine notices beside Connected notices through the same private Account artifact owner', async () => {
        listRuns.mockResolvedValue(page([]));
        const notice = { topic: 'resource_limit', kind: 'memory_pressure', phase: 'started', machineId: 'machine', at: 2000, since: 1000,
            workingSessionCount: 2, guardEnabled: false, evidence: { level: 'critical', sustainMs: 60000 } };
        const header = { v: 1, kind: 'usage_notice.v1', title: 'Machine notice', status: 'open', notice };
        const owned = createUsageNoticeArtifactFixture({ id: 'machine-notice', header, rawHeader: header, body: JSON.stringify({ v: 1, notice }) });
        const recovered = { ...notice, phase: 'recovered', at: 3000 };
        const recoveredHeader = { ...header, notice: recovered };
        const recovery = createUsageNoticeArtifactFixture({ id: 'machine-recovered', header: recoveredHeader, rawHeader: recoveredHeader, body: JSON.stringify({ v: 1, notice: recovered }) });
        const connected = createUsageNoticeArtifactFixture();
        storage.setState({ artifacts: { [owned.id]: owned, [recovery.id]: recovery, [connected.id]: connected,
            foreign: { ...owned, id: 'foreign', ownerAccountId: 'account-b' },
            shared: { ...owned, id: 'shared', access: 'view' },
            mismatch: { ...owned, id: 'mismatch', body: JSON.stringify({ v: 1, notice: recovered }) } } });
        await renderModel();
        expect(model?.openUsageNotices.map(entry => entry.artifact.id)).toEqual(['machine-notice', 'machine-recovered', 'notice-owned']);
        expect(model?.openUsageNotices.map(entry => entry.header.notice)).toEqual([notice, recovered, usageNoticeFixture]);
        expect(model?.workGroups).toEqual([]);
        expect(storage.getState().sessions).toEqual({});
        expect(await readInbox()).toMatchObject({ ok: true, result: { usageNoticeIds: ['machine-notice', 'machine-recovered', 'notice-owned'] } });
    });

    it('retries an initially unreadable Work window through the same Action and distinguishes proven empty work', async () => {
        listRuns.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(page([]));
        let workRead: SessionManagedWorkflowRunsState | null = null;
        const projection = projectWork({
            sessionId: 'session-1', reportSessions: [], agentEntries: [], workflowHeadlineRuns: [], managedRuns: [],
            ownTriggerRunIds: new Set(), describeAgentStatus: (entry) => entry.status,
            describeProgress: ({ completed, total }) => `${completed} of ${total}`,
        });
        function WorkProbe() {
            workRead = useSessionManagedWorkflowRuns({ sessionId: 'session-1', serverId: appliedSnapshot().serverId });
            return null;
        }
        function currentRead(): SessionManagedWorkflowRunsState | null { return workRead; }
        await renderScreen(<WorkProbe />);
        await act(async () => {});
        const read = () => resolveWorkReadPresentation({ projection, managedRuns: workRead, transcriptLoaded: true });
        expect(read()).toEqual({ nothingYet: false, holdWorkingPlace: false, managedUnavailable: true });
        await act(async () => { currentRead()?.retry(); });
        expect(read()).toEqual({ nothingYet: true, holdWorkingPlace: false, managedUnavailable: false });
    });

    it('exposes a pre-session Automation failure with its exact Run route and removes it on the Account wake', async () => {
        listRuns.mockResolvedValue(page([]));
        const automation = createAutomationDefinitionSummary(AutomationDefinitionListItemSchema.parse({
            id: 'automation-1', name: 'Nightly dependency check', description: null, enabled: true, targetType: 'newSession',
            existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1, assignments: [], triggers: [],
        }));
        storage.setState({ automations: { [automation.id]: automation } });
        const run = createAutomationRunFixture({ id: 'pre-session', state: 'failed', errorCode: 'machine_unavailable' });
        let needsAttention = true;
        // HTTP reports the same current window until its producer changes;
        // mounting another real consumer must not consume a one-shot fixture.
        automationBoundary.request.mockImplementation(async () => Response.json({ runs: needsAttention ? [run] : [], nextCursor: null }));
        const opened = vi.fn();
        const screen = await renderModel(<BriefRows onOpen={opened} />);
        expect(model?.automationAttentionItems).toEqual([expect.objectContaining({
            key: 'automation-run:pre-session', title: automation.name, run: expect.objectContaining({ producedSessionId: null }),
            route: expect.stringMatching(/^\/workflows\/runs\/pre-session\?target=occurrence&automationId=automation-1&serverId=/),
        })]);
        expect(model?.hasPrimaryAttention).toBe(true);
        expect(screen.findAllByType(Item).map(item => item.props.title)).toEqual([automation.name]);
        await screen.pressByTestIdAsync('voice-brief.item.automation-run:pre-session');
        expect(opened.mock.lastCall?.[0].destination).toEqual({ kind: 'automation', route: model?.automationAttentionItems[0]?.route });
        await act(async () => { storage.setState({ automations: { [automation.id]: { ...automation, name: 'Morning dependency check' } } }); });
        expect(model?.automationAttentionItems[0]).toMatchObject({ title: 'Morning dependency check' });
        expect(screen.findAllByType(Item).map(item => item.props.title)).toEqual(['Morning dependency check']);
        needsAttention = false;
        await act(async () => { publishHomeAccountChange(appliedSnapshot().serverId, ['automation:automation-1']); });
        expect(model?.automationAttentionItems).toEqual([]);
        expect(screen.findAllByType(Item)).toEqual([]);
        expect(model?.showCaughtUp).toBe(true);
    });

    it('lists an off-page hold once as its own work root, and lets it recede when it leaves the window', async () => {
        listRuns
            .mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]))
            .mockResolvedValueOnce(page([]));

        const screen = await renderModel();

        expect(model?.workGroups.map((group) => group.key)).toEqual(['run:run-held']);
        expect(model?.workGroups[0]?.items.map((item) => item.key)).toEqual(['run:run-held']);
        expect(model?.hasPrimaryAttention).toBe(true);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'ready', groups: [
            { key: model?.workGroups[0]?.key, root: { kind: 'run', runId: 'run-held' },
                items: [{ kind: 'workflow_run', key: model?.workGroups[0]?.items[0]?.key, runId: 'run-held' }] },
        ] } });
        expect(await readInbox('different-account')).toMatchObject({ ok: true, result: { status: 'unavailable' } });

        await act(async () => {
            publishHomeAccountChange(appliedSnapshot().serverId, ['workflow-run:run-held']);
        });
        await act(async () => {});

        expect(model?.workGroups).toEqual([]);
        await screen.unmount();
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });

    it('reads a valid single-Home missing lead and refuses the real mixed-Home model rather than filtering it empty', async () => {
        listRuns.mockResolvedValue(page([]));
        const serverId = appliedSnapshot().serverId;
        const first = createSessionFixture({ id: 'child', serverId, manager: { sessionId: 'unknown-lead' } });
        const foreign = createSessionFixture({ id: 'foreign', serverId: 'other-home' });
        const remindAt = Date.now() + 60_000;
        storage.setState({ sessions: { child: first }, sessionOrganizationAttentionStandingsBySessionKey: {
            [buildSessionOrganizationSessionKey(serverId, first.id)]: { sessionId: first.id, standing: true, remindAt, updatedAt: 1 },
        } });
        await renderModel();
        expect(model?.workGroups[0]?.root).toEqual({ kind: 'lead', sessionId: 'unknown-lead', session: null });
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'ready', groups: [
            { key: 'lead:unknown-lead', root: { kind: 'lead', sessionId: 'unknown-lead' },
                items: [{ kind: 'snoozed', serverId, sessionId: first.id, remindAt }] },
        ] } });
        await act(async () => { storage.setState({ sessions: { child: first, foreign },
            sessionOrganizationAttentionStandingsBySessionKey: {
                ...storage.getState().sessionOrganizationAttentionStandingsBySessionKey,
                [buildSessionOrganizationSessionKey('other-home', foreign.id)]: { sessionId: foreign.id, standing: true, remindAt, updatedAt: 1 },
            } }); });
        expect(model?.workGroups.flatMap(group => group.items)).toHaveLength(2);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });
    });

    it('projects retained Channel PR bindings into Landing and refreshes through the existing Account collection', async () => {
        listRuns.mockResolvedValue(page([]));
        const { PLUGIN_MANIFEST } = await import('@happier-dev/plugins-channels/manifest');
        const contribution = PLUGIN_MANIFEST.contributes?.accountCollections?.find(entry => entry.id === 'channel-state');
        const contract = normalizePluginAccountCollectionContractV1({ pluginId: 'happier.channels',
            contribution: PluginAccountCollectionContributionV1Schema.parse(contribution) });
        const validate = compilePluginJsonSchema(contract.schema);
        const binding = ConversationBindingV1Schema.parse({
            v: 1, id: 'binding-1', connectionId: 'connection-1', createdAt: 1, updatedAt: 1,
            endpoint: { kind: 'githubPullRequest', audience: 'shared', id: 'pr-1',
                pullRequest: { repository: 'acme/widgets', number: 1 }, pullRequestState: { state: 'open', observedAt: 100 } },
            target: { kind: 'session', sessionId: 'session-1', pullRequestLink: { repository: 'acme/widgets', number: 1 },
                policy: { deliveryMode: 'repliesOnly', permissionCeiling: 'read-only', approvals: { kind: 'off' }, newSession: { kind: 'off' } } },
            allowedPrincipalIds: ['principal-1'], allowBotSenders: false, inputMode: 'directMentionsOnly', inboundDebounceMs: 0,
            linkPreviewPolicy: 'suppress', senderFeedback: 'off', authorityEpoch: 1, enabled: false, deletionState: 'none',
        });
        const { v, id, connectionId, createdAt, updatedAt, ...payload } = binding;
        const encoded = encodePluginCollectionLogicalValueV1({ contract,
            isValidLogicalValue: value => isValidPluginJsonSchemaValue(validate, value),
            value: { id, 'record-kind': 'binding', v, 'connection-id': connectionId, 'binding-id': id,
                'created-at': createdAt, 'updated-at': updatedAt, payload },
            encryptionMode: 'plain', material: null, randomBytes: length => new Uint8Array(length).fill(9),
        });
        if (encoded.status !== 'encoded') throw new Error(encoded.reason);
        let rows = [{ rowId: encoded.rowId, revision: 1, projection: encoded.projection, content: encoded.content }];
        collectionBoundary.request.mockImplementation(async (path: string) => new Response(JSON.stringify(
            path === '/v1/account/encryption/currentness' ? createPlainAccountEncryptionCurrentnessFixture()
                : path === '/v1/plugins/data/contract' ? { access: 'readOnly', contract }
                    : { rows, changeCursor: 18 },
        ), { status: 200 }));
        const scope = storage.getState().profileScope!;
        recordAccountStoredContentServerRequirements({ serverUrl: appliedSnapshot().serverUrl,
            requirements: { v: 1, minimumProtocolVersion: 2, currentProtocolVersion: 3,
                declarationTransport: 'http-header-and-socket-auth-v1' } });
        replacePluginAccountAvailabilityProjection({ scope, snapshot: {
            availabilityCursor: 7, materializations: [], snapshots: [], intentReads: [{ pluginId: contract.pluginId,
                response: { availabilityCursor: 7, packageAssets: [],
                    hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
                    intent: { pluginId: contract.pluginId, desiredVersion: null, enabled: true, offlineUiHosting: 'enabled',
                        writableCollections: [{ pluginId: contract.pluginId, collectionId: contract.collectionId,
                            schemaVersion: contract.schemaVersion, contractDigest: contract.contractDigest }], revision: 'intent-7' },
                    release: null, uiArtifacts: [] },
            }],
        } });
        const session = createSessionFixture({ id: 'session-1', serverId: scope.serverId, active: false, seq: 0 });
        storage.setState({ sessions: { [session.id]: session } });
        await renderModel();
        expect(model?.workGroups.flatMap(group => group.items).filter(item => item.kind === 'landing'))
            .toMatchObject([{ kind: 'landing', session, link: { sessionId: session.id, serverId: scope.serverId, number: 1,
                url: 'https://github.com/acme/widgets/pull/1', state: 'open', observedAt: 100 } }]);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'ready', groups: [{ items: [{
            kind: 'landing', sessionId: session.id, pullRequestNumber: 1, pullRequestUrl: 'https://github.com/acme/widgets/pull/1',
            pullRequestState: 'open', pullRequestObservedAt: 100,
        }] }] } });
        expect(executed).toEqual([]); // Reading never takes over the producer's settlement lifecycle.
        for (const state of ['unknown', 'merged'] as const) {
            const revision = state === 'unknown' ? 2 : 3;
            const refreshed = encodePluginCollectionLogicalValueV1({ contract,
                isValidLogicalValue: value => isValidPluginJsonSchemaValue(validate, value),
                value: { id, 'record-kind': 'binding', v, 'connection-id': connectionId, 'binding-id': id,
                    'created-at': createdAt, 'updated-at': updatedAt, payload: { ...payload,
                        endpoint: { ...payload.endpoint, pullRequestState: { state, observedAt: revision * 100 } } } },
                encryptionMode: 'plain', material: null, randomBytes: length => new Uint8Array(length).fill(9),
            });
            if (refreshed.status !== 'encoded') throw new Error(refreshed.reason);
            await act(async () => {
                rows = [{ rowId: refreshed.rowId, revision, projection: refreshed.projection, content: refreshed.content }];
                resetActivePluginCollectionChanges();
            });
            const landingItems = model?.workGroups.flatMap(group => group.items).filter(item => item.kind === 'landing');
            if (state === 'unknown') {
                expect(landingItems).toMatchObject([{ link: { state: 'unknown', observedAt: 200 } }]);
                expect(await readInbox()).toMatchObject({ ok: true, result: { groups: [{ items: [{
                    kind: 'landing', pullRequestState: 'unknown', pullRequestObservedAt: 200,
                }] }] } });
            } else {
                expect(landingItems).toEqual([]);
            }
            expect(executed).toEqual([]);
        }
        await act(async () => {
            rows = [];
            resetActivePluginCollectionChanges();
        });
        expect(model?.workGroups.flatMap(group => group.items).filter(item => item.kind === 'landing')).toEqual([]);
    });

    it('settles through the one attention Action and the read-state Action, in that order', async () => {
        listRuns.mockResolvedValue(page([]));
        await renderModel();

        await act(async () => {
            await model?.settle(createSessionFixture({ id: 'session-1', serverId: appliedSnapshot().serverId }));
        });

        expect(executed).toEqual([
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', standing: false } },
            { actionId: 'session.read_state.set', input: { sessionId: 'session-1', state: 'read' } },
        ]);
    });

    it('does not claim caught up after an initial workflow failure, and retries into grouped attention', async () => {
        listRuns.mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]));
        await renderModel();

        expect(model?.workflowAttention.phase).toBe('failed');
        expect(model?.isLoading).toBe(false);
        expect(model?.showCaughtUp).toBe(false);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'unavailable' } });

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.phase).toBe('loaded');
        expect(model?.workGroups.map((group) => group.key)).toEqual(['run:run-held']);
    });

    it('waits for the first workflow read rather than showing caught up', async () => {
        listRuns.mockImplementation(() => new Promise(() => {}));
        await renderModel();

        expect(model?.workflowAttention.phase).toBe('loading');
        expect(model?.isLoading).toBe(true);
        expect(model?.showCaughtUp).toBe(false);
        expect(await readInbox()).toMatchObject({ ok: true, result: { status: 'loading' } });
    });

    it('keeps known groups during a failed workflow refresh and recovers on retry', async () => {
        listRuns.mockResolvedValueOnce(page([createWorkflowRunSummaryFixture({ id: 'run-held', state: 'interrupted' })]))
            .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page([]));
        await renderModel();
        const knownGroups = model?.workGroups;

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(true);
        expect(model?.workGroups).toBe(knownGroups);
        expect(model?.showCaughtUp).toBe(false);

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(false);
        expect(model?.showCaughtUp).toBe(true);
    });

    it('does not treat a failed refresh of a previously empty workflow list as caught up', async () => {
        listRuns.mockResolvedValueOnce(page([])).mockRejectedValueOnce(new Error('offline'));
        await renderModel();
        expect(model?.showCaughtUp).toBe(true);

        await act(async () => { model?.workflowAttention.retry(); });
        expect(model?.workflowAttention.refreshFailed).toBe(true);
        expect(model?.showCaughtUp).toBe(false);
    });

    it('snoozes with remindAt and clears it with null through the same Action', async () => {
        listRuns.mockResolvedValue(page([]));
        await renderModel();

        await act(async () => {
            await model?.setReminder(createSessionFixture({ id: 'session-1', serverId: appliedSnapshot().serverId }), 9_000);
            await model?.setReminder(createSessionFixture({ id: 'session-1', serverId: appliedSnapshot().serverId }), null);
        });

        expect(executed).toEqual([
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', remindAt: 9_000 } },
            { actionId: 'session.attention.set', input: { sessionId: 'session-1', remindAt: null } },
        ]);
    });
});
