import { describe, expect, it } from 'vitest';
import { buildDiffHunkTable } from './buildDiffHunkTable';

describe('change label range', () => {
    it('names the lines each change run lands on, not the hunk with its context', () => {
        const unifiedDiff = [
            '@@ -18,9 +18,11 @@ export function SettingsModal() {',
            ' export function SettingsModal() {',
            '   const { width } = useWindowDimensions();',
            '-  const key = `${route.path}:${width}`;',
            '+  // Keyed by route only.',
            '+  const key = useSettingsRouteKey(route);',
            '   return (',
            '-    <Modal key={key}>',
            '+    <Modal key={key} compact>',
            '       <SettingsBody />',
            '     </Modal>',
            '   );',
            '',
        ].join('\n');
        const table = buildDiffHunkTable({ mode: 'unified', filePath: 'SettingsModal.tsx', unifiedDiff });
        expect(table.hunks.map(hunk => [hunk.rangeStart, hunk.rangeEnd, hunk.rangeSide])).toEqual([[20, 21, 'new'], [23, 23, 'new']]);
    });

    it('names the removed lines of a pure deletion on the old side', () => {
        const unifiedDiff = '@@ -3,3 +3,1 @@\n keep\n-gone one\n-gone two\n';
        const table = buildDiffHunkTable({ mode: 'unified', filePath: 'a.ts', unifiedDiff });
        expect(table.hunks.map(hunk => [hunk.rangeStart, hunk.rangeEnd, hunk.rangeSide])).toEqual([[4, 5, 'old']]);
    });
});
