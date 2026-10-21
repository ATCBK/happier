import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { buildReviewUnits } from '@happier-dev/protocol/scm/comparisonOccurrences';
import { renderScreen } from '@/dev/testkit';
import { useHunkReviewController } from '@/components/workspaces/scm/review/hunkReview/useHunkReviewController';
import { buildFileChangesLiveFiles } from './fileChangesNavigation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('File page Changes: the next changed file', () => {
    it('offers and opens the next changed file once this file is reviewed (rv R2 / rvp P2)', async () => {
        const patch = '@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n';
        const kept = buildReviewUnits('src/b.ts', undefined, patch).map(unit => unit.key);
        let controller!: ReturnType<typeof useHunkReviewController>;
        const opened: string[] = [];
        function Page() {
            controller = useHunkReviewController({ source: { kind: 'live', root: '/repo' }, path: 'src/b.ts', unifiedDiff: patch,
                liveFiles: buildFileChangesLiveFiles(['src/a.ts', 'src/b.ts', 'src/c.ts'], 'src/b.ts', patch),
                host: null, serverId: null,
                marks: { record: { reviewedChangeKeys: kept } as never, unavailableReason: null, setReviewed: () => {}, setReviewedKeys: () => {}, clear: () => {} },
                onNavigate: cursor => opened.push(cursor.path) });
            return null;
        }
        await renderScreen(<Page />);
        expect(controller.strip.fileComplete).toBe(true);
        expect(controller.strip.nextFile).toBe('src/c.ts');
        expect(controller.strip.total).toBe(1);
        await act(async () => { controller.nextFile(); });
        expect(opened).toEqual(['src/c.ts']);
    });
});
