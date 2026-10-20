import * as React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { createPartialStorageModuleMock, createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { renderScreen } from '@/dev/testkit';
import type { Session } from '@/sync/domains/state/storageTypes';
import { installSessionFilesViewCommonModuleMocks } from './sessionFilesViewsTestHelpers';

const pollingSpy = vi.hoisted(() => vi.fn());

const mockSession = {
    id: 'session-1',
    seq: 0,
    createdAt: 0,
    updatedAt: 0,
    active: false,
    activeAt: 0,
    metadata: { path: '/tmp/repo', host: '' },
    metadataVersion: 0,
    agentState: null,
    agentStateVersion: 0,
    thinking: false,
    thinkingAt: 0,
    presence: 0,
} satisfies Session;

installSessionFilesViewCommonModuleMocks({
    storage: async (importOriginal) =>
        createPartialStorageModuleMock(importOriginal, {
            storage: createStorageStoreMock({}),
            useSession: (_id: string) => mockSession,
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionProjectScmSnapshot: () => null,
            useSessionProjectScmSnapshotError: () => null,
            useWorkspaceScmTouchedPathsForSession: () => [],
            useSessionProjectScmOperationLog: () => [],
            useProjectForSession: () => null,
            useProjectSessions: () => [],
            useSetting: () => 25,
        }),
});

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        openDetailsTab: vi.fn(),
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/session/files/useChangedFilesData', () => ({
    useChangedFilesData: () => ({
        sessionAttribution: { confidence: 'unknown', reason: 'unavailable' },
        sessionCheckpointOverlap: 'unknown',
        allRepositoryChangedFiles: [],
        turnAttributedFiles: [],
        turnRepositoryOnlyFiles: [],
        sessionAttributedFiles: [],
        repositoryOnlyFiles: [],

        showTurnViewToggle: false,
        showSessionViewToggle: false,
    }),
}));

vi.mock('@/sync/domains/session/changes/hooks/useDerivedSessionChangeSet', () => ({
    useDerivedSessionChangeSet: () => ({
        turnChangeSets: [],
        latestTurnChangeSet: null,
        latestTurnScopedChangeSet: null,
        sessionChangeSet: null,
        latestTurnDiffByPath: null,
        providerDiffByPath: null,
    }),
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromAutoRefresh: vi.fn(),
        invalidateFromAutoRefreshAndAwait: vi.fn(),
        invalidateFromMutationAndAwait: vi.fn(),
        invalidateFromUser: vi.fn(),
    },
}));

vi.mock('@/scm/diffCache/useScmDiffCacheLimits', () => ({
    useScmDiffCacheLimits: () => {},
}));

vi.mock('@/scm/refresh/useScmAdaptivePolling', () => ({
    useScmAdaptivePolling: pollingSpy,
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));
vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/workspaces/scm/review/ChangedFilesReview', () => ({
    ChangedFilesReview: () => React.createElement('ChangedFilesReview'),
}));

const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');

describe('SessionScmReviewDetailsView (loading)', () => {
    it('stops polling while hidden and refreshes through the current Home when shown', async () => {
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        pollingSpy.mockClear();
        const screen = await renderScreen(<SessionScmReviewDetailsView sessionId="s1" serverId="home-a" scopeId="session:s1" active={false} />);
        expect(pollingSpy.mock.lastCall?.[0].enabled).toBe(false);
        await screen.update(<SessionScmReviewDetailsView sessionId="s1" serverId="home-a" scopeId="session:s1" active />);
        const firstInvalidate = pollingSpy.mock.lastCall?.[0].invalidateAndAwait;
        await screen.update(<SessionScmReviewDetailsView sessionId="s1" serverId="home-b" scopeId="session:s1" active />);
        const nextInvalidate = pollingSpy.mock.lastCall?.[0].invalidateAndAwait;
        expect(nextInvalidate).not.toBe(firstInvalidate);
        await nextInvalidate();
        expect(scmStatusSync.invalidateFromAutoRefreshAndAwait).toHaveBeenCalledWith('s1', 'home-b');
    });
    it('shows a loading indicator while the SCM snapshot is not ready', async () => {

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionScmReviewDetailsView sessionId="s1" scopeId="session:s1" />)).tree;

        expect(tree!.findAll((node) => node.props.accessibilityRole === 'progressbar')).toHaveLength(1);
    });
});
