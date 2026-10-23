import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { createDeferred, createRenderCommitCounter, useRenderCommitCounter, renderScreen } from '@/dev/testkit';
import { V2SessionListResponseSchema } from '@happier-dev/protocol/sessions/control/contract';
import {
    ABSENT_SESSION_FOLLOW_FACTS_V1,
    NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1,
    SessionOrganizationSnapshotSchema,
    SessionViewerProjectionV1Schema,
    projectViewerReadStateV1,
    resolveSessionEffectiveNotificationV1,
    resolveSessionPersonalAttentionV1,
    resolveSessionPersonalRelevanceV1,
} from '@happier-dev/protocol';

import { createPlainSessionByIdResponseFixture, createSessionFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import type { SessionListQueryHomeInput } from '@/sync/domains/session/listing/useSessionListQuerySourceState';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeHubArtifactHttpBoundary } from '@/dev/testkit/harness/homeHubArtifactHttpBoundary';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const route = vi.hoisted(() => ({ pathname: '/session/done' }));
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
installDisconnectedServerSocketBoundary();

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return { ...createExpoRouterMock().module, usePathname: () => route.pathname };
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ Platform: { OS: 'web' } });
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
// This third-party renderer is not exercised by a session-list state hook.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({ splitStreamingRevealTextParts: () => [] }));

// Warm the actual graph during collection, outside response-ordering test budgets.
await import('./useVisibleSessionListViewState');
await import('@/sync/ops/sessions');
const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');

function currentViewer(seq: number, cursor: number, latestReadyEventSeq: number | null = null) {
    const readState = projectViewerReadStateV1({
        tracked: true,
        row: { lastViewedSessionSeq: cursor, unreadSince: cursor < seq ? 300 : null },
        visibleSessionSeq: seq,
    });
    return SessionViewerProjectionV1Schema.parse({
        readState,
        relevance: resolveSessionPersonalRelevanceV1({ ...NO_SESSION_PERSONAL_RELEVANCE_FACTS_V1, ownedByMe: true }),
        attention: resolveSessionPersonalAttentionV1({
            tracked: true, accessible: true, accountSuspended: false, contentAvailable: true,
            visibleSessionSeq: seq, readState, latestReadyEventSeq, hasPrimarySessionFailure: false,
            pendingBlockedCount: 0, pendingPermissionRequestCount: 0, pendingUserActionRequestCount: 0,
            capabilities: { canSubmitAgentInput: true, canApprovePermissions: true },
            responsible: false, discussion: { hasUnread: false, hasMention: false },
            attentionStanding: 'none', reminderDue: false,
        }),
        follow: ABSENT_SESSION_FOLLOW_FACTS_V1,
        notification: resolveSessionEffectiveNotificationV1({ facts: ABSENT_SESSION_FOLLOW_FACTS_V1, isSessionOwner: true }),
    });
}

function completedSession(cursor: number, serverId: string) {
    return createSessionFixture({
        id: 'done', serverId, owner: 'u1', seq: 3, lastViewedSessionSeq: cursor,
        viewer: currentViewer(3, cursor, 3), latestTurnStatus: 'completed',
        latestReadyEventSeq: 3, latestReadyEventAt: 300,
        lastTurnCompletedAt: 300, updatedAt: 300, active: false, presence: 0,
    });
}

describe('visible session-list retained attention through real state', () => {
    let previousState: ReturnType<(typeof import('@/sync/domains/state/storage'))['storage']['getState']>;
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
    let serverId: string;
    let archiveResponse: (() => Promise<Response>) | undefined;
    let snapshotResponse = createDeferred<void>();
    let listedSessions: ReturnType<typeof createSessionFixture>[] = [];

    beforeEach(async () => {
        archiveResponse = undefined;
        snapshotResponse = createDeferred<void>();
        await home.reset();
        projectManager.clear();
        const { storage } = await import('@/sync/domains/state/storage');
        previousState = storage.getState();
        await loadSyncSingletonForTests();
        serverId = await home.addHome({ name: 'Retained attention Home', serverUrl: 'https://retained-attention.test', accountId: 'u1' });
        const settings = {
            sessionListOrderingModeV1: 'custom', sessionListAttentionPromotionModeV1: 'global',
            sessionListAttentionStandingDefaultV1: false, sessionListWorkingPlacementModeV1: 'off',
            sessionListSectionModeV1: 'single', sessionListActiveGroupingV1: 'date',
            sessionListInactiveGroupingV1: 'date', hideInactiveSessions: false, sessionFolderViewModeV1: 'off',
        } as const;
        listedSessions = [completedSession(2, serverId), createSessionFixture({
            id: 'quiet', serverId, owner: 'u1', seq: 1, lastViewedSessionSeq: 1,
            viewer: currentViewer(1, 1), updatedAt: 100, active: false, presence: 0,
        })];
        const http = createHomeHubArtifactHttpBoundary('u1');
        account = await restoreServerAccountForTest({ serverUrl: 'https://retained-attention.test', accountId: 'u1', request: async (input, init) => {
            if (/^\/v2\/sessions\/(done|quiet)\/archive$/.test(new URL(String(input)).pathname) && archiveResponse) return await archiveResponse();
            if (new URL(String(input)).pathname === '/v2/sessions') {
                await snapshotResponse.promise;
                return Response.json(V2SessionListResponseSchema.parse({
                    sessions: listedSessions.map(session => ({ ...createPlainSessionByIdResponseFixture(session).session,
                        viewer: createSessionOwnerViewerFixture(session) })),
                    nextCursor: null, hasNext: false, attentionNextCursor: null, attentionHasNext: false,
                }));
            }
            if (['/v2/sessions/active', '/v2/sessions/attention'].includes(new URL(String(input)).pathname)) {
                return Response.json({ sessions: [], nextCursor: null, hasNext: false });
            }
            if (new URL(String(input)).pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settings }, version: 1 });
            const bootstrap = createEmptyAccountBootstrapHttpResponse(new URL(String(input)).pathname, init);
            if (bootstrap) return bootstrap;
            return http.request(input, init);
        } });
        expect(account.home.id).toBe(serverId);
        await storage.getState().activateSettingsScope({ serverId, accountId: 'u1' });
        storage.getState().applySettingsLocal(settings);
        storage.getState().applySessionOrganizationSnapshot(serverId, SessionOrganizationSnapshotSchema.parse({
            schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [],
            tagAssignments: [], orderEntries: [], labels: [],
        }));
        storage.getState().applySessions(listedSessions);
        // Hydration is deliberately row-only. Ordinary admission belongs to the
        // server page producer, not to whichever Session was opened or updated.
        storage.getState().applyServerScopedSessionListRows(serverId, Object.values(storage.getState().sessionListRowsByServerId[serverId] ?? {}), {
            source: 'ordinary', mode: 'replace',
        });
        route.pathname = '/session/done';
        vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 1, 17));
    });

    afterEach(async () => {
        snapshotResponse.resolve();
        await standardCleanup();
        // Identity discovery advances the connection generation. This test
        // still owns that Home, while the captured account disposer correctly
        // refuses to retire a later generation on its caller's behalf.
        const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
        await disconnectActiveServerConnection();
        await account?.dispose();
        account = undefined;
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(previousState, true);
        await home.reset();
        projectManager.clear();
    });

    it('confines repeated row-content publications to the changed row, without list commits', async () => {
        const { storage, useSessionListRenderableWithServerScope } = await import('@/sync/domains/state/storage');
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const sessions = Array.from({ length: 24 }, (_, index) => createSessionFixture({
            id: `render-row-${index}`, serverId, owner: 'u1', seq: 1, lastViewedSessionSeq: 1,
            viewer: currentViewer(1, 1), updatedAt: 100, active: false, presence: 0,
            metadata: { name: `Row ${index}`, path: '/workspace', host: 'test' },
        }));
        storage.getState().applySessions(sessions);
        storage.getState().applyServerScopedSessionListRows(serverId,
            sessions.map(session => storage.getState().sessionListRowsByServerId[serverId]![session.id]!),
            { source: 'ordinary', mode: 'replace' });
        route.pathname = '/';
        const listCounter = createRenderCommitCounter();
        const rowCounters = new Map(sessions.map(session => [session.id, createRenderCommitCounter()]));
        function Row({ id }: { id: string }) {
            useRenderCommitCounter(rowCounters.get(id)!);
            const row = useSessionListRenderableWithServerScope(serverId, id);
            return React.createElement('row', { id, name: row?.metadata?.name });
        }
        function List() {
            useRenderCommitCounter(listCounter);
            const state = useVisibleSessionListViewState();
            return React.createElement(React.Fragment, null, state.visibleSessionListIndex?.flatMap(item =>
                item.type === 'session' ? [React.createElement(Row, { key: item.sessionId, id: item.sessionId })] : []));
        }
        const screen = await renderScreen(React.createElement(List));
        try {
            await flushHookEffects({ cycles: 2, turns: 2 });
            expect(screen.findAllByType('row')).toHaveLength(24);
            listCounter.reset();
            for (const counter of rowCounters.values()) counter.reset();
            for (let update = 1; update <= 5; update += 1) {
                await act(async () => {
                    storage.getState().applySessions([{
                        ...sessions[0]!, metadataVersion: update,
                        metadata: { ...sessions[0]!.metadata!, name: `Changed ${update}` },
                    }]);
                });
            }
            const counts = { list: listCounter.read(), rows: Object.fromEntries(
                [...rowCounters].map(([id, counter]) => [id, counter.read()])) };
            expect(screen.findAllByType('row').find(row => row.props.id === sessions[0]!.id)?.props.name).toBe('Changed 5');
            expect(counts.list).toEqual({ renders: 0, commits: 0 });
            expect(rowCounters.get(sessions[0]!.id)!.read()).toEqual({ renders: 5, commits: 5 });
            for (const session of sessions.slice(1)) {
                expect(rowCounters.get(session.id)!.read()).toEqual({ renders: 0, commits: 0 });
            }
        } finally {
            await act(async () => screen.unmount());
        }
    });

    it('retains keyed row projections and confines five new arrivals to the admitted rows', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const sessions = Array.from({ length: 24 }, (_, index) => createSessionFixture({
            id: `admission-row-${index}`, serverId, owner: 'u1', seq: 1,
            viewer: currentViewer(1, 1), lastViewedSessionSeq: 1, active: false, presence: 0,
            createdAt: 100 + index, updatedAt: 100 + index,
        }));
        storage.getState().applySessions(sessions);
        storage.getState().applyServerScopedSessionListRows(serverId,
            sessions.map(session => storage.getState().sessionListRowsByServerId[serverId]![session.id]!),
            { source: 'ordinary', mode: 'replace' });
        route.pathname = '/';
        const counters = new Map(sessions.map(session => [session.id, createRenderCommitCounter()]));
        const listCounter = createRenderCommitCounter();
        const Row = React.memo(function Row({ item }: { item: Extract<import('@/sync/domains/sessionList/sessionListIndex').SessionListIndexItem, { type: 'session' }> }) {
            const counter = counters.get(item.sessionId);
            if (!counter) throw Error('Missing row counter');
            useRenderCommitCounter(counter);
            return React.createElement('admission-row', { id: item.sessionId });
        });
        function List() {
            useRenderCommitCounter(listCounter);
            const state = useVisibleSessionListViewState();
            return React.createElement(React.Fragment, null, state.visibleSessionListIndex?.flatMap(item =>
                item.type === 'session' ? [React.createElement(Row, { key: item.sessionId, item })] : []));
        }
        const screen = await renderScreen(React.createElement(List));
        try {
            for (const counter of counters.values()) counter.reset();
            listCounter.reset();
            for (let index = 0; index < 5; index++) {
                const session = createSessionFixture({ ...sessions[0]!, id: `new-arrival-${index}`, createdAt: 1_000 + index });
                counters.set(session.id, createRenderCommitCounter());
                await act(async () => {
                    storage.getState().applySessions([session]);
                    storage.getState().applyServerScopedSessionListRows(serverId,
                        [storage.getState().sessionListRowsByServerId[serverId]![session.id]!],
                        { source: 'ordinary', mode: 'append' });
                });
            }
            expect(screen.findAllByType('admission-row')).toHaveLength(29);
            expect(listCounter.read()).toEqual({ renders: 5, commits: 5 });
            expect(sessions.map(session => counters.get(session.id)!.read())).toEqual(
                sessions.map(() => ({ renders: 0, commits: 0 })));
            for (let index = 0; index < 5; index++) expect(counters.get(`new-arrival-${index}`)!.read())
                .toEqual({ renders: 1, commits: 1 });
        } finally { await screen.unmount(); }
    });

    it.each(['ordinary', 'query', 'warm query'] as const)('retains multiple pending archive rows in the %s source until their public operations finish', async mode => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const { stopSessionAndMaybeArchive } = await import('@/components/sessions/sessionStopArchiveFlow');
        const { sessionArchiveWithServerScope } = await import('@/sync/ops/sessions');
        const entered = createDeferred<void>();
        const response = createDeferred<Response>();
        let enteredCount = 0;
        archiveResponse = async () => {
            if (++enteredCount === 2) entered.resolve();
            return (await response.promise).clone();
        };
        route.pathname = '/';
        if (mode !== 'warm query') {
            snapshotResponse.resolve();
            const { getSyncSingleton } = await import('@/sync/runtime/getSyncSingleton');
            await getSyncSingleton().refreshSessions({ awaitSessionListHydration: true });
        }
        let queryHomes: readonly SessionListQueryHomeInput[] | undefined = mode !== 'ordinary' ? [{ serverId,
            query: { v: 1, scope: 'my_work', storage: 'active', includeInactive: true,
                attention: 'any', audiences: [], tagIds: [] },
            ordinaryAdapter: { path: '/v2/sessions', allowV1Fallback: true, membership: 'ordinary' },
        } as const] : undefined;
        const hook = await renderHook(() => useVisibleSessionListViewState('all', { queryHomes }));
        const visibleIds = () => hook.getCurrent()?.visibleSessionListIndex
            ?.flatMap(item => item.type === 'session' ? [item.sessionId] : []);
        expect(visibleIds()).toContain('done');
        if (mode === 'warm query') expect(hook.getCurrent()?.query?.statesByServerId[serverId]?.appliedQueryKey).toBeNull();
        let settledVisibleIds: string[] | undefined;
        let pending: Promise<unknown> = Promise.resolve();
        await act(async () => {
            pending = Promise.all(['done', 'quiet'].map(sessionId => stopSessionAndMaybeArchive({
                address: { serverId, sessionId },
                hideInactiveSessions: false, isPinned: false, archiveAfterStop: 'always',
                stopSession: async () => ({ success: true }),
                archiveSession: () => sessionArchiveWithServerScope(sessionId, { serverId }),
                stopErrorMessage: 'Stop failed', archiveErrorMessage: 'Archive failed',
            })));
        });
        try {
            await entered.promise;
            const { setServerProfileIdentityForUrl } = await import('@/sync/domains/server/serverProfiles');
            const { readSessionArchivePending } = await import('@/sync/domains/session/listing/sessionArchiveState');
            const discoveredHome = 'srv_archive_retained_identity';
            await act(async () => { await setServerProfileIdentityForUrl('https://retained-attention.test', discoveredHome); });
            expect(visibleIds()).toContain('done');
            expect(readSessionArchivePending(storage.getState(), { serverId: discoveredHome, sessionId: 'done' })).toBe(true);
            await act(async () => {
                // The server can publish its committed archival before the HTTP
                // response arrives. Exercise the same canonical row/membership writer.
                storage.getState().applyServerScopedSessionListRowPatches(discoveredHome, [
                    { sessionId: 'done', patch: { archivedAt: 42 } },
                    { sessionId: 'quiet', patch: { archivedAt: 42 } },
                ]);
            });
            expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).not.toContain('done');
            expect(storage.getState().sessionArchiveOperations[serverId]?.done).toBeDefined();
            expect(storage.getState().sessionArchiveOperations[serverId]?.quiet).toBeDefined();
            expect(visibleIds()).toEqual(expect.arrayContaining(['done', 'quiet']));
            if (queryHomes) {
                queryHomes = queryHomes.map(home => ({ ...home, query: { ...home.query, tagIds: ['different-tag'] } }));
                await hook.rerender();
                expect(visibleIds() ?? []).not.toContain('done');
                expect(visibleIds() ?? []).not.toContain('quiet');
                expect(readSessionArchivePending(storage.getState(), { serverId: discoveredHome, sessionId: 'done' })).toBe(true);
            }
        } finally {
            await act(async () => {
                response.resolve(Response.json({ success: true, archivedAt: 42 }));
                await pending;
            });
            settledVisibleIds = visibleIds();
            await hook.unmount();
        }
        expect(storage.getState().sessionArchiveOperations).toEqual({});
        expect(settledVisibleIds ?? []).not.toContain('done');
        expect(settledVisibleIds ?? []).not.toContain('quiet');
    });

    it('uses a retained foreground pathname when retaining selected attention after remount', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).toEqual(['done', 'quiet']);
        expect(storage.getState().sessionListIndexByServerId[serverId]?.filter((item) => item.type === 'session')
            .map((item) => item.sessionId)).toEqual(['done', 'quiet']);
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const expectedIndex = [
            expect.objectContaining({ type: 'header', headerKind: 'attention' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'attention' }),
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ];
        const firstHook = await renderHook(() => useVisibleSessionListViewState('all'));
        await flushHookEffects();
        const retainedVisibleSessionListIndex = firstHook.getCurrent()?.visibleSessionListIndex;
        expect(retainedVisibleSessionListIndex).toEqual(expectedIndex);
        await firstHook.unmount();

        storage.getState().applySessions([completedSession(3, serverId)]);
        route.pathname = '/';
        let remountOptions = { pathname: '/', retainedPathname: '/session/done', retainedVisibleSessionListIndex };
        const remountedHook = await renderHook(() => useVisibleSessionListViewState('all', remountOptions));
        await flushHookEffects();
        expect(remountedHook.getCurrent()?.visibleSessionListIndex).toEqual(expectedIndex);
        await remountedHook.rerender();
        expect(remountedHook.getCurrent()?.visibleSessionListIndex).toEqual(expectedIndex);

        // Acknowledgement must not move the foreground row while it is being
        // read, but leaving that retained route must release its attention seat.
        remountOptions = { ...remountOptions, retainedPathname: '/' };
        await remountedHook.rerender();
        expect(remountedHook.getCurrent()?.visibleSessionListIndex).toEqual([
            expect.objectContaining({ type: 'header', headerKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'done', groupKind: 'date' }),
            expect.objectContaining({ type: 'session', sessionId: 'quiet', groupKind: 'date' }),
        ]);
        await remountedHook.unmount();
    });
});
