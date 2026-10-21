import * as React from 'react';
import type { DiffHunkTable } from './buildDiffHunkTable';

/** Navigation consumes review units; it never infers hunk boundaries from display headers. */
export function useDiffHunkNavigation(table: DiffHunkTable) {
    const [selection, setSelection] = React.useState({ table, index: -1 });
    const index = selection.table === table ? selection.index : -1;
    const move = (direction: -1 | 1) => {
        if (table.hunks.length === 0) return undefined;
        const nextIndex = Math.max(0, Math.min(table.hunks.length - 1, index + direction));
        setSelection({ table, index: nextIndex });
        return table.hunks[nextIndex]?.revealLineId;
    };
    return {
        count: table.hunks.length,
        currentIndex: index < 0 ? null : index,
        scrollToLineId: table.hunks[index]?.revealLineId,
        canPrevious: index > 0,
        canNext: index < table.hunks.length - 1,
        next: () => move(1),
        previous: () => move(-1),
    };
}
