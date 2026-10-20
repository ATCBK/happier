import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createPartialStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { renderScreen } from '@/dev/testkit';
import { UniversalSearchRuntimeProvider } from '@/components/appShell/search/UniversalSearchRuntimeContext';

let snapshot: unknown = null;

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key) });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

let touched: string[] = [];
vi.mock('@/sync/domains/state/storage', async (importOriginal) => createPartialStorageModuleMock(importOriginal, {
    useSessionProjectScmSnapshot: () => snapshot,
    useWorkspaceScmTouchedPathsForSession: () => touched,
}));

/** A real snapshot shape: the count is the canonical changed-file list (`selectScmChangedFiles`). */
const STATS = { includedAdded: 0, includedRemoved: 0, pendingAdded: 1, pendingRemoved: 0, isBinary: false };

function changedSnapshot(count: number, extraEntries: readonly unknown[] = []) {
    return {
        repo: { isRepo: true, rootPath: '/repo', backendId: 'git', mode: '.git', worktrees: [] },
        capabilities: {},
        branch: { head: 'main', upstream: null, ahead: 0, behind: 0, detached: false },
        totals: { includedFiles: 0, pendingFiles: count, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: count, pendingRemoved: 0 },
        entries: [
            ...Array.from({ length: count }, (_unused, index) => ({
                path: `src/file-${index}.ts`, previousPath: null, kind: 'modified', includeStatus: ' ', pendingStatus: 'M',
                hasIncludedDelta: false, hasPendingDelta: true, stats: STATS,
            })),
            ...extraEntries,
        ],
    };
}

/** The files search is the app's runtime boundary for Open file…; record what it was asked to open. */
function withSearch(element: React.ReactElement, open: (...args: unknown[]) => void) {
    return <UniversalSearchRuntimeProvider value={{ open, buildCommands: () => [] }}>{element}</UniversalSearchRuntimeProvider>;
}

describe('SessionDetailsEmptyState (empty editor column, lab EM1)', () => {
    it('opens the files search from its one primary action', async () => {
        snapshot = changedSnapshot(0);
        touched = [];
        const open = vi.fn();
        const { SessionDetailsEmptyState } = await import('./SessionDetailsEmptyState');
        const screen = await renderScreen(withSearch(<SessionDetailsEmptyState sessionId="s1" openDetailsTab={vi.fn()} />, open));
        await screen.pressByTestIdAsync('pane-empty-editor-open-file');
        expect(open).toHaveBeenCalledWith(undefined, undefined, { source: 'files' });
    });

    it('lists only the files this session changed and opens one as a file tab', async () => {
        snapshot = changedSnapshot(3);
        touched = ['src/file-1.ts'];
        const openDetailsTab = vi.fn();
        const { SessionDetailsEmptyState } = await import('./SessionDetailsEmptyState');
        const screen = await renderScreen(withSearch(<SessionDetailsEmptyState sessionId="s1" openDetailsTab={openDetailsTab} />, vi.fn()));
        expect(screen.findByTestId('pane-empty-editor-changed-src/file-0.ts')).toBeNull();
        await screen.pressByTestIdAsync('pane-empty-editor-changed-src/file-1.ts');
        expect(openDetailsTab).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file' }), { intent: 'pinned' });
    });

    it('keeps reading every change one press away and counts them like every changed-files list', async () => {
        snapshot = changedSnapshot(2, [{
            path: 'vendor/', previousPath: null, kind: 'untracked', includeStatus: '?', pendingStatus: '?',
            hasIncludedDelta: false, hasPendingDelta: true, stats: STATS,
        }]);
        touched = [];
        const openDetailsTab = vi.fn();
        const { SessionDetailsEmptyState } = await import('./SessionDetailsEmptyState');
        const screen = await renderScreen(withSearch(<SessionDetailsEmptyState sessionId="s1" openDetailsTab={openDetailsTab} />, vi.fn()));
        expect(screen.getTextContent()).toContain('detailsSurface.chrome.reviewChanges:{"count":2}');
        await screen.pressByTestIdAsync('pane-empty-editor-review');
        expect(openDetailsTab).toHaveBeenCalledWith(
            expect.objectContaining({ key: 'scmReview:working', kind: 'scmReview' }),
            { intent: 'pinned' },
        );
    });

    it('offers no review and no list when nothing changed', async () => {
        snapshot = changedSnapshot(0);
        touched = [];
        const { SessionDetailsEmptyState } = await import('./SessionDetailsEmptyState');
        const screen = await renderScreen(withSearch(<SessionDetailsEmptyState sessionId="s1" openDetailsTab={vi.fn()} />, vi.fn()));
        expect(screen.findByTestId('pane-empty-editor-review')).toBeNull();
        expect(screen.getTextContent()).not.toContain('panes.emptyEditor.changedInSession');
    });
});
