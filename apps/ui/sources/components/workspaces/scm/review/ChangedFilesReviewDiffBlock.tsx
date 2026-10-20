import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { Modal } from '@/modal';
import type { CodeLinesExternalScrollView } from '@/components/ui/code/view/CodeLinesViewCore';
import * as React from 'react';
import type { FindController } from '@happier-dev/plugin-ui/presentation';
import { Image, Platform, StyleSheet, View, useWindowDimensions } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { useSetting } from '@/sync/domains/state/storage';

import { DiffViewer } from '@/components/ui/code/diff/DiffViewer';
import { useDiffHunkTable } from '@/components/ui/code/diff/hunks/useDiffHunkTable';
import type { DiffHunkInfo, DiffViewerHunks } from '@/components/ui/code/diff/diffViewerTypes';
import { CODE_LINE_BASE_HEIGHT } from '@/components/ui/code/view/CodeLineRow';
import { DiffReviewCommentsViewer } from '@/components/ui/code/diff/reviewComments/DiffReviewCommentsViewer';
import { resolveInlineDiffVirtualization } from '@/components/ui/code/diff/resolveInlineDiffVirtualization';
import { useInlineDiffVirtualizationThresholds } from '@/components/ui/code/diff/useInlineDiffVirtualizationThresholds';
import { resolveInlineDiffVirtualizedMaxHeight } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedMaxHeight';
import { resolveInlineDiffVirtualizedViewportStyle } from '@/components/ui/code/diff/resolveInlineDiffVirtualizedViewportStyle';

import { resolveFileViewerKind } from '@/scm/utils/filePresentation';
import { useFilePreviewSource } from '@/components/ui/media/useFilePreviewSource';
import { buildWorkspacePreviewIdentity } from '@/components/ui/media/buildWorkspacePreviewIdentity';
import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import type { ChangedFilesReviewDiffStateSource } from '@/components/workspaces/scm/review/ChangedFilesReviewDiffStore';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type { ChangedFilesReviewFindModel } from './useChangedFilesReviewFind';

export type ReviewDiffState = Readonly<{
    status: 'idle' | 'loading' | 'loaded' | 'error';
    diff: string;
    error: string | null;
    /** Loaded: a new file with no bytes. */
    emptyFile?: boolean;
}>;

export type ChangedFilesReviewDiffBlockProps = Readonly<{
    theme: any;
    sessionId: string;
    snapshotSignature: string | null;
    workspaceScope?: WorkspaceScopeBase | null;
    filePath: string;
    isBinaryContent?: boolean;
    estimatedChangedLines?: number | null;
    diffStateSource: ChangedFilesReviewDiffStateSource;
    reviewCommentsEnabled: boolean;
    reviewCommentDrafts: readonly ReviewCommentDraft[];
    onUpsertReviewCommentDraft?: (draft: ReviewCommentDraft) => void;
    onDeleteReviewCommentDraft?: (commentId: string) => void;
    onReviewCommentError?: (message: string) => void;
    onScrollToLine?: (windowY: number) => void;
    externalScrollView?: CodeLinesExternalScrollView;
    scrollToLineId?: string;
    findModel?: ChangedFilesReviewFindModel;
    findActive?: boolean;
    /** Edge to edge under the file header, without the inset rounded frame (the comparison stream). */
    flat?: boolean;
    evidenceOnly?: boolean;
    hunkNotes?: Readonly<{
        placement: 'column' | 'inline';
        columnWidth: number;
        render: (path: string, hunkIndex: number, placement: 'column' | 'inline') => React.ReactNode;
    }> | null;
}>;

function buildDiffDraftsSignature(filePath: string, drafts: readonly ReviewCommentDraft[]): string {
    let signature = '';
    for (const draft of drafts) {
        if (draft.filePath !== filePath || draft.source !== 'diff') continue;
        signature += `${draft.id}\u0000${draft.body}\u0000${draft.includeInPrompt === false ? '0' : '1'}\u0000${draft.createdAt}\u0000`;
        signature += `${JSON.stringify(draft.anchor)}\u0000${JSON.stringify(draft.snapshot)}\u0000`;
    }
    return signature;
}

/** The comparison stream draws diffs edge to edge under their file header (lab WT8). */
const FLAT_BLOCK_STYLE = { paddingHorizontal: 0, paddingVertical: 0 } as const;
const FLAT_DIFF_FRAME_STYLE = { overflow: 'hidden' } as const;

function areChangedFilesReviewDiffBlockPropsEqual(
    prev: ChangedFilesReviewDiffBlockProps,
    next: ChangedFilesReviewDiffBlockProps,
): boolean {
    if (
        prev.theme !== next.theme
        || prev.sessionId !== next.sessionId
        || prev.snapshotSignature !== next.snapshotSignature
        || prev.workspaceScope !== next.workspaceScope
        || prev.filePath !== next.filePath
        || prev.isBinaryContent !== next.isBinaryContent
        || prev.estimatedChangedLines !== next.estimatedChangedLines
        || prev.diffStateSource !== next.diffStateSource
        || prev.reviewCommentsEnabled !== next.reviewCommentsEnabled
        || prev.onUpsertReviewCommentDraft !== next.onUpsertReviewCommentDraft
        || prev.onDeleteReviewCommentDraft !== next.onDeleteReviewCommentDraft
        || prev.scrollToLineId !== next.scrollToLineId
        || prev.findModel !== next.findModel
        || prev.findActive !== next.findActive
        || prev.onScrollToLine !== next.onScrollToLine
        || prev.externalScrollView !== next.externalScrollView
        || prev.onReviewCommentError !== next.onReviewCommentError
        || prev.flat !== next.flat
        || prev.evidenceOnly !== next.evidenceOnly
        || prev.hunkNotes !== next.hunkNotes
    ) {
        return false;
    }

    if (prev.reviewCommentDrafts === next.reviewCommentDrafts) return true;
    if (!prev.reviewCommentsEnabled) return true;

    return buildDiffDraftsSignature(prev.filePath, prev.reviewCommentDrafts)
        === buildDiffDraftsSignature(next.filePath, next.reviewCommentDrafts);
}

/** Space between two Explain notes that would otherwise touch in the column. */
const HUNK_NOTE_STACK_GAP_PX = 8;

/**
 * Where a hunk starts, for the Explain column (lab WT8-F2). A zero-height marker after the hunk's first
 * content line, measured against the block frame. The notes themselves never render inside the diff
 * renderer: the web renderer paints only inside its own code box (`contain: content`), so anything
 * placed beside the code from in there is clipped away.
 */
function HunkNoteAnchor(props: Readonly<{
    hunkIndex: number;
    frameRef: React.RefObject<View | null>;
    generation: number;
    onMeasure: (hunkIndex: number, y: number) => void;
}>) {
    const ref = React.useRef<View>(null);
    const { frameRef, hunkIndex, onMeasure } = props;
    const measure = React.useCallback(() => {
        const node = ref.current;
        const frame = frameRef.current;
        if (!node || !frame) return;
        node.measureLayout(frame, (_x, y) => onMeasure(hunkIndex, y), () => {});
    }, [frameRef, hunkIndex, onMeasure]);
    React.useEffect(() => { measure(); }, [measure, props.generation]);
    return <View ref={ref} collapsable={false} onLayout={measure} style={{ height: 0 }} />;
}

/**
 * The Explain column beside a file's code: each hunk's notes top-aligned with the hunk's first line,
 * pushed down only when the note above is taller than the code between them. Returns the column and
 * the height it needs, so the block never lets a note run into the next file.
 */
function useHunkNotesColumn(input: Readonly<{
    filePath: string;
    hunkNotes: NonNullable<ChangedFilesReviewDiffBlockProps['hunkNotes']>;
    tops: ReadonlyMap<number, number>;
    borderColor: string;
}>): Readonly<{ column: React.ReactNode; minHeight: number }> {
    const [heights, setHeights] = React.useState<ReadonlyMap<number, number>>(() => new Map());
    const onNoteLayout = React.useCallback((hunkIndex: number, height: number) => {
        setHeights((current) => current.get(hunkIndex) === height ? current : new Map(current).set(hunkIndex, height));
    }, []);
    let cursor = 0;
    const notes: React.ReactNode[] = [];
    for (const [hunkIndex, anchorY] of [...input.tops.entries()].sort((a, b) => a[0] - b[0])) {
        const node = input.hunkNotes.render(input.filePath, hunkIndex, 'column');
        if (!node) continue;
        const top = Math.max(anchorY - CODE_LINE_BASE_HEIGHT, cursor);
        cursor = top + (heights.get(hunkIndex) ?? 0) + HUNK_NOTE_STACK_GAP_PX;
        notes.push(
            <View key={hunkIndex} style={{ position: 'absolute', top, left: 0, right: 0 }}
                onLayout={(event) => onNoteLayout(hunkIndex, event.nativeEvent.layout.height)}>
                {node}
            </View>,
        );
    }
    const column = (
        <View pointerEvents="box-none" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: input.hunkNotes.columnWidth,
            borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: input.borderColor }}>
            {notes}
        </View>
    );
    return { column, minHeight: cursor };
}

export const ChangedFilesReviewDiffBlock = React.memo((props: ChangedFilesReviewDiffBlockProps) => {
    const { theme, sessionId, filePath, snapshotSignature } = props;
    const registerFindRefold = React.useCallback((refold: NonNullable<FindController['refold']>) =>
        props.findModel?.registerRefold(filePath, refold), [filePath, props.findModel]);
    const findRangesByLineId = React.useSyncExternalStore(
        React.useCallback((listener) => props.findModel?.subscribeFile(filePath, listener) ?? (() => {}), [filePath, props.findModel]),
        () => props.findModel?.getFileSnapshot(filePath).ranges,
    );
    const state = React.useSyncExternalStore(
        React.useCallback((listener) => props.diffStateSource.subscribe(filePath, listener), [filePath, props.diffStateSource]),
        React.useCallback(() => props.diffStateSource.getDiffState(filePath), [filePath, props.diffStateSource]),
        React.useCallback(() => props.diffStateSource.getDiffState(filePath), [filePath, props.diffStateSource]),
    );
    const noOverflowAnchor = Platform.OS === 'web' ? ({ overflowAnchor: 'none' } as any) : null;
    const testIdSafePath = React.useMemo(() => toTestIdSafeValue(filePath), [filePath]);
    const blockTestId = `scm-review-diff-${testIdSafePath}`;

    const diffLoaded = state.status === 'loaded';
    const hunkTable = useDiffHunkTable({ mode: 'unified', filePath, unifiedDiff: state.diff }, Boolean(props.hunkNotes || props.scrollToLineId));
    const columnNotes = props.hunkNotes?.placement === 'column' ? props.hunkNotes : null;
    const frameRef = React.useRef<View>(null);
    const [noteTops, setNoteTops] = React.useState<ReadonlyMap<number, number>>(() => new Map());
    const [measureGeneration, setMeasureGeneration] = React.useState(0);
    const onAnchorMeasure = React.useCallback((hunkIndex: number, y: number) => {
        setNoteTops((current) => current.get(hunkIndex) === y ? current : new Map(current).set(hunkIndex, y));
    }, []);
    const onFrameLayout = React.useCallback(() => setMeasureGeneration((value) => value + 1), []);
    const renderNote = React.useCallback((hunk: DiffHunkInfo) => {
        const hunkIndex = hunk.hunkIndex;
        // Explain notes describe the captured git hunk, even when it contains several review units.
        if (!props.hunkNotes || hunkTable.hunks[hunk.index - 1]?.hunkIndex === hunkIndex) return null;
        if (props.hunkNotes.placement === 'column') {
            return <HunkNoteAnchor hunkIndex={hunkIndex} frameRef={frameRef} generation={measureGeneration} onMeasure={onAnchorMeasure} />;
        }
        return props.hunkNotes.render(filePath, hunkIndex, props.hunkNotes.placement);
    }, [filePath, measureGeneration, hunkTable.hunks, onAnchorMeasure, props.hunkNotes]);
    const hunks = React.useMemo<DiffViewerHunks | undefined>(() => {
        if (!props.hunkNotes && !props.scrollToLineId) return undefined;
        const currentIndex = hunkTable.hunks.findIndex((hunk) => hunk.firstChangeLineId === props.scrollToLineId);
        return { currentIndex: currentIndex < 0 ? null : currentIndex, renderNote: props.hunkNotes ? renderNote : undefined };
    }, [hunkTable.hunks, props.hunkNotes, props.scrollToLineId, renderNote]);
    const notesColumn = useHunkNotesColumn({ filePath, hunkNotes: columnNotes ?? EMPTY_COLUMN_NOTES, tops: columnNotes ? noteTops : EMPTY_NOTE_TOPS,
        borderColor: theme.colors.border.default });
    const noteColumnStyle = columnNotes ? { paddingRight: columnNotes.columnWidth, minHeight: notesColumn.minHeight } : null;
    const hasDiff = diffLoaded && Boolean(state.diff);
    const fileViewer = resolveFileViewerKind({ path: filePath, isBinaryContent: props.isBinaryContent });
    const fileIsBinary = fileViewer.kind !== 'code' && fileViewer.kind !== 'markdown' && fileViewer.kind !== 'svg';
    const fileIsImage = fileViewer.kind === 'image' || fileViewer.kind === 'svg';

    const imagePreview = useFilePreviewSource({
        source: props.workspaceScope ? { kind: 'workspace', scope: props.workspaceScope, filePath }
            : { kind: 'session', sessionId, filePath },
        ...(props.workspaceScope ? buildWorkspacePreviewIdentity(props.workspaceScope, filePath, null, snapshotSignature)
            : { cacheKey: snapshotSignature }),
        mimeType: fileViewer.mimeType,
        enabled: props.evidenceOnly !== true && diffLoaded && !state.diff && fileIsImage,
    });

    const wrapLines = useSetting('wrapLinesInDiffs');
    const showLineNumbers = useSetting('showLineNumbers');
    const { lineThreshold: virtualizationLineThreshold, byteThreshold: virtualizationByteThreshold } = useInlineDiffVirtualizationThresholds();
    const { height: windowHeight } = useWindowDimensions();
    const maxVirtualizedHeight = resolveInlineDiffVirtualizedMaxHeight(windowHeight);
    const effectiveWrapLines = wrapLines !== false;
    const effectiveShowLineNumbers = showLineNumbers !== false;

    const estimatedChangedLines = React.useMemo(() => {
        const raw = props.estimatedChangedLines;
        if (raw === null || raw === undefined) return null;
        if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
        return Math.max(0, Math.floor(raw));
    }, [props.estimatedChangedLines]);

    const virtualized = React.useMemo(() => {
        if (props.reviewCommentsEnabled) return false;
        if (!state.diff) return false;
        return resolveInlineDiffVirtualization({
            unifiedDiff: state.diff,
            oldText: null,
            newText: null,
            lineThreshold: virtualizationLineThreshold,
            byteThreshold: virtualizationByteThreshold,
        });
    }, [props.reviewCommentsEnabled, state.diff, virtualizationByteThreshold, virtualizationLineThreshold]);

    const diffContainerStyle = virtualized ? resolveInlineDiffVirtualizedViewportStyle(maxVirtualizedHeight) : null;
    const shouldReserveVirtualizedHeightWhileLoading = React.useMemo(() => {
        if (props.reviewCommentsEnabled) return false;
        const estimated = estimatedChangedLines;
        if (estimated === null) return false;
        return estimated >= virtualizationLineThreshold;
    }, [estimatedChangedLines, props.reviewCommentsEnabled, virtualizationLineThreshold]);
    // Reserve height during loading for large diffs so rows don't "grow" once a diff arrives
    // (which can cause scroll jumps in virtualized lists). Avoid reserving the large virtualized
    // height for small diffs to prevent stale layout caches from leaving large whitespace gaps.
    const loadingContainerStyle = shouldReserveVirtualizedHeightWhileLoading ? { height: maxVirtualizedHeight } : null;

    if (state.status === 'loading' || state.status === 'idle') {
        return (
            <View testID={blockTestId} style={[props.flat ? FLAT_BLOCK_STYLE : { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 }, noOverflowAnchor]}>
                <View
                    style={[
                        props.flat
                            ? { alignItems: 'center', justifyContent: 'center', paddingVertical: theme.space.s12 }
                            : {
                                borderRadius: 12,
                                overflow: 'hidden',
                                borderWidth: 1,
                                borderColor: theme.colors.border.default,
                                alignItems: 'center',
                                justifyContent: 'center',
                            },
                        loadingContainerStyle,
                    ]}
                >
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                </View>
            </View>
        );
    }
    if (state.status === 'error') {
        return (
            <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary,  }}>
                    {state.error ?? t('files.reviewUnableToLoadDiff')}
                </Text>
            </View>
        );
    }
    if (!state.diff) {
        if (fileIsImage) {
            if (imagePreview.status === 'loading') {
                return (
                    <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    </View>
                );
            }

            if (imagePreview.status === 'loaded') {
                return (
                    <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12, gap: theme.space.s10 }, noOverflowAnchor]}>
                        <HappierPressable
                            testID="scm-review-image-preview"
                            accessibilityRole="button"
                            accessibilityLabel={`${t('common.open')}: ${filePath}`}
                            onPress={async () => {
                                const { AttachmentImagePreviewModal } = await import('@/components/sessions/attachments/preview/AttachmentImagePreviewModal');
                                Modal.show({
                                    component: AttachmentImagePreviewModal,
                                    props: { images: [{ kind: 'session-image', sessionId, workspaceScope: props.workspaceScope, filePath, title: filePath }] },
                                });
                            }}
                            style={{
                                width: '100%',
                                maxWidth: 860,
                                height: 280,
                                borderRadius: 12,
                                overflow: 'hidden',
                                borderWidth: 1,
                                borderColor: theme.colors.border.default,
                                backgroundColor: theme.colors.surface.inset ?? theme.colors.surface.base,
                            }}
                        >
                            <Image
                                source={{ uri: imagePreview.uri }}
                                resizeMode="contain"
                                style={{ width: '100%', height: '100%' }}
                                accessibilityLabel={t('files.binaryFile')}
                            />
                        </HappierPressable>
                        <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary,  }}>
                            {t('files.binaryFile')}
                        </Text>
                    </View>
                );
            }

            if (imagePreview.status === 'error') {
                return (
                    <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                        <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary,  }}>
                            {imagePreview.error}
                        </Text>
                    </View>
                );
            }
        }

        if (fileIsBinary) {
            return (
                <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                    <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary,  }}>
                        {t('files.binaryFile')}
                    </Text>
                </View>
            );
        }

        return (
            <View testID={blockTestId} style={[{ paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s12 }, noOverflowAnchor]}>
                <Text style={{ ...Typography.variant('meta'), color: theme.colors.text.secondary,  }}>
                    {state.emptyFile ? t('files.emptyFile') : t('files.noChanges')}
                </Text>
            </View>
        );
    }

    if (props.reviewCommentsEnabled) {
        return (
            <View ref={frameRef} collapsable={false} onLayout={columnNotes ? onFrameLayout : undefined} testID={blockTestId} style={[props.flat ? FLAT_BLOCK_STYLE : { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 }, noOverflowAnchor, noteColumnStyle]}>
                <DiffReviewCommentsViewer
                    findActive={props.findActive}
                    findRangesByLineId={findRangesByLineId}
                    hunks={hunks}
                    scrollToLineId={props.scrollToLineId}
                    highlightLineId={props.scrollToLineId}
                    onScrollToLine={props.onScrollToLine}
                    externalScrollView={props.externalScrollView}
                    filePath={filePath}
                    unifiedDiff={state.diff}
                    reviewCommentsEnabled={true}
                    reviewCommentDrafts={props.reviewCommentDrafts}
                    wrapLines={effectiveWrapLines}
                    showLineNumbers={effectiveShowLineNumbers}
                    onUpsertReviewCommentDraft={props.onUpsertReviewCommentDraft}
                    onDeleteReviewCommentDraft={props.onDeleteReviewCommentDraft}
                    onReviewCommentError={props.onReviewCommentError}
                />
                {columnNotes ? notesColumn.column : null}
            </View>
        );
    }

    return (
            <View ref={frameRef} collapsable={false} onLayout={columnNotes ? onFrameLayout : undefined} testID={blockTestId} style={[props.flat ? FLAT_BLOCK_STYLE : { paddingHorizontal: theme.space.s16, paddingVertical: theme.space.s8 }, noOverflowAnchor, noteColumnStyle]}>
            <View style={[props.flat ? FLAT_DIFF_FRAME_STYLE : { borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: theme.colors.border.default }, diffContainerStyle]}>
                <DiffViewer
                    findActive={props.findActive}
                    registerFindRefold={registerFindRefold}
                    findRangesByLineId={findRangesByLineId}
                    hunks={hunks}
                    scrollToLineId={props.scrollToLineId}
                    highlightLineId={props.scrollToLineId}
                    onScrollToLine={props.onScrollToLine}
                    externalScrollView={props.externalScrollView}
                    mode="unified"
                    unifiedDiff={state.diff}
                    filePath={filePath}
                    wrapLines={effectiveWrapLines}
                    showLineNumbers={effectiveShowLineNumbers}
                    virtualized={virtualized}
                />
            </View>
            {columnNotes ? notesColumn.column : null}
        </View>
    );
}, areChangedFilesReviewDiffBlockPropsEqual);

const EMPTY_NOTE_TOPS: ReadonlyMap<number, number> = new Map();
const EMPTY_COLUMN_NOTES: NonNullable<ChangedFilesReviewDiffBlockProps['hunkNotes']> = { placement: 'column', columnWidth: 0, render: () => null };
