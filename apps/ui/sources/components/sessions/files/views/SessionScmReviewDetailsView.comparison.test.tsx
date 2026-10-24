import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ScmComparisonSchema } from '@happier-dev/protocol/scm';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { standardCleanup } from '@/dev/testkit';
import { createSessionFilesViewFixture, fileViewSnapshot, installSessionFilesViewBoundaries, prepareSessionFilesViewTestkit } from './sessionFilesViewTestkit';

installSessionFilesViewBoundaries();
let fixture: Awaited<ReturnType<typeof createSessionFilesViewFixture>>;
beforeAll(prepareSessionFilesViewTestkit);
afterEach(async () => {
    standardCleanup();
    if (fixture) {
        const { retireScmDiffSummaryScope } = await import('@/sync/ops/scmDiffSummary/generate');
        retireScmDiffSummaryScope({ serverId: fixture.home.id, accountId: 'alice' });
    }
    await fixture?.dispose();
});

describe('SessionScmReviewDetailsView (comparison)', () => {
    it('shows the captured turn a link names and switches scope within the same destination', async () => {
        const comparison = ScmComparisonSchema.parse({ id: 'a'.repeat(64),
            source: { kind: 'turnCheckpoint', turnId: 'turn_1' }, repository: { rootPath: '/tmp/repo' },
            endpoints: { before: 'turn-1-before', after: 'turn-1-after' },
            inventory: { state: 'complete', reasons: [], files: [{ path: 'src/earlier.ts', changeKind: 'modified',
                binary: false, generated: false, lockfile: false, occurrences: [{
                    id: 'earlier-change', alias: 'c1', path: 'src/earlier.ts', position: 0,
                    before: { startLine: 1, lineCount: 1 }, after: { startLine: 1, lineCount: 1 },
                }],
                evidence: { state: 'available', unifiedDiff: 'diff --git a/src/earlier.ts b/src/earlier.ts\n--- a/src/earlier.ts\n+++ b/src/earlier.ts\n@@ -1 +1 @@\n-before\n+after\n' } }] } });
        fixture = await createSessionFilesViewFixture({ rootPath: '/tmp/repo', rpc: request =>
            request.method === RPC_METHODS.SCM_DIFF_SUMMARY_CAPTURE ? { success: true, comparison,
                metadata: { sourceKey: comparison.id, source: comparison.source } } : undefined });
        fixture.storage.getState().applySessions([{ ...fixture.session, latestTurnId: 'turn_2' }]);
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        const { ScmComparisonScopePicker } = await import('@/components/sessions/files/comparison/ScmComparisonScopePicker');
        const { CapturedComparisonFilesView } = await import('@/components/sessions/files/comparison/CapturedComparisonFilesView');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const { useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope');
        let pane: ReturnType<typeof useAppPaneScope> | undefined;
        function PaneProbe() {
            pane = useAppPaneScope('session:s1');
            return null;
        }
        const screen = await fixture.render(<><PaneProbe /><SessionScmReviewDetailsView sessionId="s1"
            serverId={fixture.home.id} scopeId="session:s1"
            target={{ comparison: { kind: 'turnCheckpoint', turnId: 'turn_1' }, view: 'files' }} /></>);
        await vi.waitFor(() => expect(screen.findByTestId('captured-comparison-files')).not.toBeNull());
        expect(screen.findByType(CapturedComparisonFilesView).props.comparison.endpoints).toEqual(comparison.endpoints);
        const review = screen.findByType(ChangedFilesReview).props as React.ComponentProps<typeof ChangedFilesReview>;
        expect(review.evidenceOnly).toBe(true);
        expect(review.allRepositoryChangedFiles.map(file => file.fullPath)).toEqual(['src/earlier.ts']);
        expect(fixture.requests.filter(request => request.method === RPC_METHODS.SCM_STATUS_SNAPSHOT)).toEqual([]);
        const picker = screen.findByType(ScmComparisonScopePicker).props as React.ComponentProps<typeof ScmComparisonScopePicker>;
        expect(picker.current).toEqual({ kind: 'turnCheckpoint', turnId: 'turn_1', comparisonId: comparison.id });
        expect(picker.options.map(option => option.comparison)).toEqual(expect.arrayContaining([
            { kind: 'workingTree' }, { kind: 'session' }, { kind: 'turnCheckpoint', turnId: 'turn_2' },
            { kind: 'turnCheckpoint', turnId: 'turn_1', comparisonId: comparison.id },
        ]));
        await act(async () => picker.onSelect({ kind: 'session' }));
        expect(pane?.scopeState?.details.tabs[0]?.resource).toMatchObject({ comparison: { kind: 'session' }, view: 'files' });
        await screen.pressByTestIdAsync('scm-comparison-view:walkthrough');
        expect(pane?.scopeState?.details.tabs).toHaveLength(1);
        expect(pane?.scopeState?.details.tabs[0]?.resource).toMatchObject({
            comparison: { kind: 'turnCheckpoint', turnId: 'turn_1', comparisonId: comparison.id }, view: 'walkthrough',
        });
    });

    it('says it cannot show a comparison it cannot read yet, instead of showing another one', async () => {
        fixture = await createSessionFilesViewFixture();
        fixture.setSnapshot(fileViewSnapshot());
        const { SessionScmReviewDetailsView } = await import('./SessionScmReviewDetailsView');
        const { ChangedFilesReview } = await import('@/components/workspaces/scm/review/ChangedFilesReview');
        const screen = await fixture.render(<SessionScmReviewDetailsView sessionId="s1" serverId={fixture.home.id}
            scopeId="session:s1" target={{ comparison: { kind: 'turnCheckpoint' } }} />);
        expect(screen.findAllByType(ChangedFilesReview)).toHaveLength(0);
        expect(screen.findByTestId('scm-comparison-unsupported')).not.toBeNull();
        expect(screen.findByTestId('captured-comparison-files')).toBeNull();
    });
});
