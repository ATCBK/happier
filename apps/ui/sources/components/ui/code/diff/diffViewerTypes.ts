import type { CodeLinesViewProps } from '@/components/ui/code/view/CodeLinesView';
import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import type { ReactNode } from 'react';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import type { ReviewUnit } from '@happier-dev/protocol/scm/comparisonOccurrences';

export type DiffViewerMode = 'unified' | 'text';

export type DiffHunkInfo = Readonly<{
    index: number;
    hunkIndex: number;
    key: string;
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    sectionHeading: string;
    firstChangeLineId: string;
}>;

export type DiffHunkReviewState = 'open' | 'kept' | 'discarding';
export type DiffHunkAction = 'keep' | 'discard' | 'ask' | 'copy';

export type DiffViewerHunks = Readonly<{
    onHunks?: (hunks: readonly DiffHunkInfo[]) => void;
    currentIndex?: number | null;
    stateOf?: (hunk: DiffHunkInfo) => DiffHunkReviewState;
    actions?: Readonly<Partial<Record<DiffHunkAction, (hunk: DiffHunkInfo) => void>>>;
    disabledReason?: (hunk: DiffHunkInfo, action: DiffHunkAction) => string | null;
    numberOffset?: number;
    renderNote?: (hunk: DiffHunkInfo) => ReactNode;
}>;

export type DiffViewerBaseProps = Readonly<{
    hunks?: DiffViewerHunks;
    /** Captured evidence supplies its canonical per-layer keys to the shared table. */
    reviewUnits?: readonly ReviewUnit[];
    /** Surface-owned evidence state, used instead of raw patch bytes when rendering fails. */
    errorFallback?: ReactNode;
    filePath?: string | null;
    wrapLines?: boolean;
    showLineNumbers?: boolean;
    showPrefix?: boolean;
    virtualized?: boolean;
    contentPaddingHorizontal?: number;
    contentPaddingVertical?: number;
    /**
     * Optional override for the web/desktop diff presentation style.
     * Useful for compact surfaces (e.g. timeline/tool cards) where split diffs
     * waste horizontal space, especially for new/deleted files.
     */
    presentationStyleOverride?: 'unified' | 'split';
    scrollToLineId?: string;
    onScrollToLine?: CodeLinesViewProps['onScrollToLine'];
    externalScrollView?: CodeLinesViewProps['externalScrollView'];
    highlightLineId?: string;
    highlightLineIds?: CodeLinesViewProps['highlightLineIds'];
    findActive?: boolean;
    /** Bind this mounted renderer's temporary Find refold operation to its surface controller. */
    registerFindRefold?: (refold: NonNullable<FindController['refold']>) => (() => void) | undefined;
    findRangesByLineId?: CodeLinesViewProps['findRangesByLineId'];
    selectedLineIds?: ReadonlySet<string>;
    testID?: CodeLinesViewProps['testID'];
    onLayout?: CodeLinesViewProps['onLayout'];
    onContentSizeChange?: CodeLinesViewProps['onContentSizeChange'];
    onScroll?: CodeLinesViewProps['onScroll'];
    scrollEventThrottle?: CodeLinesViewProps['scrollEventThrottle'];
    interactionMode?: CodeLinesViewProps['interactionMode'];
    rangeSelectionActive?: CodeLinesViewProps['rangeSelectionActive'];
    onPressLine?: CodeLinesViewProps['onPressLine'];
    onPressLineRange?: CodeLinesViewProps['onPressLineRange'];
    pressLineWhenNotSelectable?: CodeLinesViewProps['pressLineWhenNotSelectable'];
    onPressAddComment?: CodeLinesViewProps['onPressAddComment'];
    isCommentActive?: CodeLinesViewProps['isCommentActive'];
    renderAfterLine?: CodeLinesViewProps['renderAfterLine'];
    showInactiveCommentAffordance?: CodeLinesViewProps['showInactiveCommentAffordance'];
}>;

export type UnifiedDiffViewerProps = DiffViewerBaseProps & Readonly<{
    mode: 'unified';
    unifiedDiff: string;
    precomputedLines?: readonly CodeLine[];
}>;

export type TextDiffViewerProps = DiffViewerBaseProps & Readonly<{
    mode: 'text';
    oldText: string;
    newText: string;
    contextLines?: number;
    /**
     * `prose`: R5, the reading face for instructions people read (two labelled sides, proportional type,
     * soft bands, no hunk headers). `code` (default) is the code diff.
     */
    face?: 'code' | 'prose';
    /** The prose face's side labels and, when a choice is made, which side is kept (the other dims). */
    prose?: Readonly<{ oldLabel?: ReactNode; newLabel?: ReactNode; kept?: 'old' | 'new' | null }>;
}>;

export type DiffViewerProps = UnifiedDiffViewerProps | TextDiffViewerProps;
