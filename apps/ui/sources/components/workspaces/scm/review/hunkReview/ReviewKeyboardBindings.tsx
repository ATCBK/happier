import * as React from 'react';
import { classifyScmChangePath } from '@happier-dev/protocol/scm/comparison';
import { useDiffHunkTable } from '@/components/ui/code/diff/hunks/useDiffHunkTable';
import type { ChangedFilesReviewDiffStateSource } from '../ChangedFilesReviewDiffStore';
import type { ChangedFilesReviewLineTarget } from '../ChangedFilesReviewNavigation';
import { moveHunkReviewCursor, type HunkReviewCursor } from './hunkReviewModel';
import { useReviewKeyboard, type ReviewKeyboardController } from './useReviewKeyboard';

export type ReviewKeyboardBindingsProps = Readonly<{
    enabled: boolean;
    paths: readonly string[];
    activePath: string | null;
    onFocusPath: (path: string) => void;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    onFocusLine: (target: ChangedFilesReviewLineTarget | null) => void;
    /** Rich review surfaces supply their existing controller, including marks and Undo. */
    controller?: ReviewKeyboardController;
    /** The reading surface supplies its focus boundary when it shares a pane with other controls. */
    containsFocus?: () => boolean;
}>;

/** Registers into the one keyboard dispatcher; it renders no surface. */
export function ReviewKeyboardBindings(props: ReviewKeyboardBindingsProps) {
    const activePath = props.activePath ?? props.paths[0] ?? null;
    const observedPath = props.enabled && !props.controller ? activePath : null;
    const source = props.diffStateSource;
    const state = React.useSyncExternalStore(
        React.useCallback(listener => observedPath ? source.subscribe(observedPath, listener) : () => {}, [observedPath, source]),
        () => observedPath ? source.getDiffState(observedPath) : null,
        () => observedPath ? source.getDiffState(observedPath) : null,
    );
    const table = useDiffHunkTable({ mode: 'unified', filePath: activePath, unifiedDiff: state?.diff ?? '' }, Boolean(observedPath));
    const [selected, setSelected] = React.useState<HunkReviewCursor | null>(null);
    const currentKey = selected?.path === activePath && table.hunks.some(hunk => hunk.key === selected.key)
        ? selected.key : table.hunks[0]?.key ?? null;
    const move = (direction: 1 | -1, fileOnly = false) => {
        if (!activePath || state?.status !== 'loaded') return;
        const files = props.paths.map(path => ({ path, ...classifyScmChangePath(path),
            keys: path === activePath ? table.hunks.map(hunk => hunk.key) : [], pending: path !== activePath }));
        const cursor = currentKey ? { path: activePath, key: currentKey } : null;
        const next = moveHunkReviewCursor(files, cursor, direction, new Set(), fileOnly);
        if (!next) return;
        setSelected(next);
        if (next.path !== activePath) { props.onFocusPath(next.path); return; }
        const destination = table.hunks.find(hunk => hunk.key === next.key);
        if (destination) props.onFocusLine({ filePath: activePath, lineId: destination.firstChangeLineId });
    };
    useReviewKeyboard(props.controller ?? {
        next: () => move(1), previous: () => move(-1), nextFile: () => move(1, true), previousFile: () => move(-1, true),
    }, { active: props.enabled, containsFocus: props.containsFocus });
    return null;
}
