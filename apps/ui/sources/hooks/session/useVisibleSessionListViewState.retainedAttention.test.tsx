import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createDeferred } from '@/dev/testkit';
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

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
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

    beforeEach(async () => {
        archiveResponse = undefined;
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
        const http = createHomeHubArtifactHttpBoundary('u1');
        account = await restoreServerAccountForTest({ serverUrl: 'https://retained-attention.test', accountId: 'u1', request: async (input, init) => {
            if (new URL(String(input)).pathname === '/v2/sessions/done/archive' && archiveResponse) return await archiveResponse();
            if (new URL(String(input)).pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: settings }, version: 1 });
            return http.request(input, init);
        } });
        expect(account.home.id).toBe(serverId);
        await storage.getState().activateSettingsScope({ serverId, accountId: 'u1' });
        storage.getState().applySettingsLocal(settings);
        storage.getState().applySessionOrganizationSnapshot(serverId, SessionOrganizationSnapshotSchema.parse({
            schemaVersion: 1, version: 1, pins: [], folders: [], folderAssignments: [], tags: [],
            tagAssignments: [], orderEntries: [], labels: [],
        }));
        storage.getState().applySessions([
            completedSession(2, serverId),
            createSessionFixture({ id: 'quiet', serverId, owner: 'u1', seq: 1, lastViewedSessionSeq: 1, viewer: currentViewer(1, 1), updatedAt: 100, active: false, presence: 0 }),
        ]);
        // Hydration is deliberately row-only. Ordinary admission belongs to the
        // server page producer, not to whichever Session was opened or updated.
        storage.getState().applyServerScopedSessionListRows(serverId, Object.values(storage.getState().sessionListRowsByServerId[serverId] ?? {}), {
            source: 'ordinary', mode: 'replace',
        });
        route.pathname = '/session/done';
        vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 1, 17));
    });

    afterEach(async () => {
        await standardCleanup();
        await account?.dispose();
        account = undefined;
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState(previousState, true);
        await home.reset();
        projectManager.clear();
    });

    it('retains a pending archive row across authoritative membership settlement until its public operation finishes', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { useVisibleSessionListViewState } = await import('./useVisibleSessionListViewState');
        const { stopSessionAndMaybeArchive } = await import('@/components/sessions/sessionStopArchiveFlow');
        const { sessionArchiveWithServerScope } = await import('@/sync/ops/sessions');
const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
        const entered = createDeferred<void>();
        const response = createDeferred<Response>();
        archiveResponse = async () => { entered.resolve(); return await response.promise; };
        route.pathname = '/';
        const hook = await renderHook(() => useVisibleSessionListViewState('all'));
        const visibleIds = () => hook.getCurrent()?.visibleSessionListIndex
            ?.flatMap(item => item.type === 'session' ? [item.sessionId] : []);
        expect(visibleIds()).toContain('done');
        let settledVisibleIds: string[] | undefined;
        const pending = stopSessionAndMaybeArchive({ address: { serverId, sessionId: 'done' },
            hideInactiveSessions: false, isPinned: false, archiveAfterStop: 'always',
            stopSession: async () => ({ success: true }),
            archiveSession: () => sessionArchiveWithServerScope('done', { serverId }),
            stopErrorMessage: 'Stop failed', archiveErrorMessage: 'Archive failed',
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
                ]);
            });
            expect(storage.getState().ordinarySessionListMembershipByServerId[serverId]).not.toContain('done');
            expect(storage.getState().sessionArchiveOperations[serverId]?.done).toBeDefined();
            expect(visibleIds()).toContain('done');
        } finally {
            await act(async () => {
                response.resolve(Response.json({ success: true, archivedAt: 42 }));
                await pending;
            });
            settledVisibleIds = visibleIds();
            await hook.unmount();
        }
        expect(storage.getState().sessionArchiveOperations).toEqual({});
        expect(settledVisibleIds).not.toContain('done');
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
