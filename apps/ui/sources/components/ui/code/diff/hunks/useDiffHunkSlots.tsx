import * as React from 'react';
import type { DiffHunkInfo, DiffViewerHunks, DiffViewerProps } from '../diffViewerTypes';
import { useDiffHunkTable } from './useDiffHunkTable';
import { composeDiffLineSlots } from './composeDiffLineSlots';

/** Host-private binding: the UI lane supplies the one DiffHunkRow drawing here. */
export type DiffHunkRowRenderer = (hunk: DiffHunkInfo, review: DiffViewerHunks) => React.ReactNode;

export function useDiffHunkSlots(props: DiffViewerProps, renderRow?: DiffHunkRowRenderer) {
    const table = useDiffHunkTable(props, props.hunks !== undefined);
    const review = props.hunks;
    const renderAfterLine = React.useMemo(() => {
        if (!review) return props.renderAfterLine;
        return composeDiffLineSlots(props.renderAfterLine, (line) => {
            const hunks = table.hunksByAfterLineId.get(line.id);
            if (!hunks) return null;
            const nodes = hunks.flatMap((hunk) => {
                const row = renderRow?.(hunk, review);
                const note = review.renderNote?.(hunk);
                const visible = [row, note].some((node) => node !== null && node !== undefined && typeof node !== 'boolean');
                return visible ? [<React.Fragment key={hunk.key}>{row}{note}</React.Fragment>] : [];
            });
            return nodes.length > 0 ? <>{nodes}</> : null;
        });
    }, [props.renderAfterLine, renderRow, review, table]);
    return { table, renderAfterLine };
}
