import * as React from 'react';
import type { DiffHunkInfo, DiffViewerHunks, DiffViewerProps } from '../diffViewerTypes';
import { useDiffHunkTable } from './useDiffHunkTable';
import { composeDiffLineSlots } from './composeDiffLineSlots';

/** Host-private binding: the UI lane supplies the one DiffHunkRow drawing here. */
export type DiffHunkRowRenderer = (hunk: DiffHunkInfo, review: DiffViewerHunks) => React.ReactNode;

export function useDiffHunkSlots(props: DiffViewerProps, renderRow?: DiffHunkRowRenderer) {
    const table = useDiffHunkTable(props, props.hunks !== undefined);
    const hosted = props.hunks;
    const onPressAddComment = props.onPressAddComment;
    // Comment on a change is the surface's own line comment at the change's first line (the phone menu's Comment).
    const review = React.useMemo(() => {
        if (!hosted || !onPressAddComment || hosted.actions?.comment) return hosted;
        const comment = (hunk: DiffHunkInfo) => {
            const line = table.firstChangeLineByKey.get(hunk.key);
            if (line) onPressAddComment(line);
        };
        return { ...hosted, actions: { ...hosted.actions, comment } };
    }, [hosted, onPressAddComment, table]);
    const renderAfterLine = React.useMemo(() => {
        if (!review) return props.renderAfterLine;
        return composeDiffLineSlots(props.renderAfterLine, (line) => {
            const hunks = table.hunksByAfterLineId.get(line.id);
            if (!hunks) return null;
            const nodes = hunks.flatMap((hunk) => {
                // The review row draws review verbs; when a host offers its own choices instead (the editor's
                // Compare: Use mine · Use theirs) and no review row applies, those choices are the hunk's row.
                const row = renderRow?.(hunk, review) ?? review.renderActions?.(hunk);
                const note = review.renderNote?.(hunk);
                const visible = [row, note].some((node) => node !== null && node !== undefined && typeof node !== 'boolean');
                return visible ? [<React.Fragment key={hunk.key}>{row}{note}</React.Fragment>] : [];
            });
            return nodes.length > 0 ? <>{nodes}</> : null;
        });
    }, [props.renderAfterLine, renderRow, review, table]);
    // Kept units let go of their tint; their rows keep the "Kept" label (lab ade-shell RV2 R1).
    const stateOf = review?.stateOf;
    const keptKeys = table.hunks.filter(hunk => stateOf?.(hunk) === 'kept').map(hunk => hunk.key).join('\n');
    const reviewedLineIds = React.useMemo(() => {
        if (!keptKeys) return undefined;
        const kept = new Set(keptKeys.split('\n'));
        return new Set(table.hunks.filter(hunk => kept.has(hunk.key)).flatMap(hunk => hunk.changeLineIds));
    }, [keptKeys, table]);
    return { table, renderAfterLine, reviewedLineIds };
}
