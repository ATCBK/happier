import * as React from 'react';

import type { DiffViewerProps } from './diffViewerTypes';
import { HappierUnifiedDiffViewer } from './happier/HappierUnifiedDiffViewer';
import { HappierTextDiffViewer } from './happier/HappierTextDiffViewer';
import { useEffectiveDiffWrapLines } from './diffPresentationStyle';
import { ProseDiffViewer } from './prose/ProseDiffViewer';
import { useDiffHunkSlots } from './hunks/useDiffHunkSlots';

export const DiffViewer = React.memo<DiffViewerProps>((props) => {
    const wrapLines = useEffectiveDiffWrapLines(props.wrapLines);
    const { renderAfterLine } = useDiffHunkSlots(props);
    // Prose is its own face on every renderer: a reading layout, not a code diff.
    if (props.mode === 'text' && props.face === 'prose') return <ProseDiffViewer {...props} />;
    if (props.mode === 'unified') {
        return <HappierUnifiedDiffViewer {...props} renderAfterLine={renderAfterLine} wrapLines={wrapLines} />;
    }
    return <HappierTextDiffViewer {...props} renderAfterLine={renderAfterLine} wrapLines={wrapLines} />;
});
