import * as React from 'react';
import type { DiffViewerProps } from '../diffViewerTypes';
import { buildDiffHunkTable, type DiffHunkTable } from './buildDiffHunkTable';

const EMPTY_TABLE: DiffHunkTable = { hunks: [], hunksByAfterLineId: new Map(), firstChangeLineByKey: new Map() };

export function useDiffHunkTable(props: DiffViewerProps, enabled = true): DiffHunkTable {
    const unifiedDiff = props.mode === 'unified' ? props.unifiedDiff : undefined;
    const oldText = props.mode === 'text' ? props.oldText : undefined;
    const newText = props.mode === 'text' ? props.newText : undefined;
    const contextLines = props.mode === 'text' ? props.contextLines : undefined;
    const table = React.useMemo(() => enabled ? buildDiffHunkTable(props) : EMPTY_TABLE,
        // Review state and callbacks never rebuild content identity or anchors.
        [enabled, props.mode, props.filePath, props.reviewUnits, unifiedDiff, oldText, newText, contextLines]);
    const onHunks = props.hunks?.onHunks;
    React.useEffect(() => { if (enabled) onHunks?.(table.hunks); }, [enabled, onHunks, table.hunks]);
    return table;
}
