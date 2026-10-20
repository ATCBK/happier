import React from 'react';
import { FlatList, Platform, View } from 'react-native';
import type { SharedValue } from 'react-native-reanimated';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';
import { codeLineScrollTargetKey } from '@/components/ui/code/model/codeLineScrollTargetKey';
import type { CodeLinesSyntaxHighlightingConfig } from '@/components/ui/code/highlighting/useCodeLinesSyntaxHighlighting';
import {
    resolveCodeLineRangeSelection,
    type CodeLineInteractionMode,
} from '@/components/ui/code/interactions/resolveCodeLineRangeSelection';

import { CodeLineRow, CODE_LINE_BASE_HEIGHT, type CodeLineDiagnosticRange, type CodeLinePressEvent } from './CodeLineRow';
import { resolveEffectiveSyntaxHighlighting } from './resolveEffectiveSyntaxHighlighting';
import { CodeLinesReadingAnchor, type NativeCodeReadingAnchor } from './CodeLinesReadingAnchor';
import type { FindTextRange } from '@happier-dev/plugin-ui/presentation';
import type { Rect } from '../editor/codeEditorTypes';
import { CODE_GUTTER_METRICS } from '../editor/codeEditorFontMetrics';

export type CodeLinesExternalScrollView = Readonly<{
    scrollRef: React.RefObject<{ scrollTo: (options: { y: number; animated: boolean }) => void } | null>;
    contentRef?: React.RefObject<View | null>;
    viewportRef?: React.RefObject<View | null>;
    offsetRef: React.RefObject<number>;
}>;

function measureExternalLayout(
    owner: CodeLinesExternalScrollView,
    row: View,
    measured: (x: number, y: number, width: number, height: number) => void,
): void {
    const content = owner.contentRef?.current;
    if (content) {
        row.measureLayout(content, measured);
        return;
    }
    owner.viewportRef?.current?.measureInWindow((_x, viewportY) => {
        row.measureInWindow((x, y, width, height) => {
            measured(x, y - viewportY + owner.offsetRef.current, width, height);
        });
    });
}

export type CodeLinesViewProps = {
    lines: readonly CodeLine[];
    selectedLineIds?: ReadonlySet<string>;
    interactionMode?: CodeLineInteractionMode;
    rangeSelectionActive?: boolean;
    onPressLine?: (line: CodeLine, event?: CodeLinePressEvent) => void;
    onPressLineRange?: (lines: readonly CodeLine[]) => void;
    pressLineWhenNotSelectable?: boolean;
    onPressAddComment?: (line: CodeLine) => void;
    isCommentActive?: (line: CodeLine) => boolean;
    renderAfterLine?: (line: CodeLine) => React.ReactNode;
    /**
     * A lane before the line numbers, one cell per line (Blame's run column). The cell sits outside the
     * line's own press target, so it can be its own control; it stretches to the line's wrapped height.
     */
    renderLeadingLane?: (line: CodeLine) => React.ReactNode;
    showInactiveCommentAffordance?: boolean;
    contentPaddingHorizontal?: number;
    contentPaddingVertical?: number;
    wrapLines?: boolean;
    virtualized?: boolean;
    showLineNumbers?: boolean;
    lineNumberDigits?: number;
    reviewLaneWidth?: number;
    showPrefix?: boolean;
    syntaxHighlighting?: CodeLinesSyntaxHighlightingConfig;
    scrollToLineId?: string;
    /** Inline native viewers delegate measured targets to their enclosing scroll owner. */
    onScrollToLine?: (windowY: number) => void;
    externalScrollView?: CodeLinesExternalScrollView;
    highlightLineId?: string;
    highlightLineIds?: ReadonlySet<string>;
    reviewedLineIds?: ReadonlySet<string>;
    /** An agent's write landing while you read (P3-R8): these lines take the add tint, faded by `opacity`. */
    liveTint?: Readonly<{ lineIds: ReadonlySet<string>; opacity: SharedValue<number> }>;
    findRangesByLineId?: ReadonlyMap<string, readonly FindTextRange[]>;
    intelligence?: Readonly<{
        /** `rect` is the pointed line's box at the pointer (window space), for anchoring a card. */
        onPointerToken: (lineId: string, offset16: number, rect: Rect | null, newLine: number) => void;
        /** Modifier-click (desktop) or a plain tap (touch, outside a selection). */
        onActivateToken: (lineId: string, offset16: number, activation: Readonly<{ via: 'modifier' | 'touch'; rect: Rect | null }>, newLine: number) => void;
        /** The pointer left code text (whitespace past a line's end, the gutter, outside the view). */
        onPointerAway?: () => void;
        /** The file's problems by 1-based file line (squiggles on new-side lines), from the page's language answers. */
        diagnosticsByNewLine?: ReadonlyMap<number, readonly CodeLineDiagnosticRange[]>;
    }>;
    testID?: string;
    onLayout?: (e: any) => void;
    onContentSizeChange?: (width: number, height: number) => void;
    onScroll?: (e: any) => void;
    scrollEventThrottle?: number;
};

type InlineToken = Readonly<{ text: string; color: string }>;
type PreventableEvent = Readonly<{
    preventDefault?: () => void;
    nativeEvent?: Readonly<{ preventDefault?: () => void }>;
}>;

const EMPTY_LINE_ID_SET: ReadonlySet<string> = new Set();

/** `data-code-line-kind/-old/-new` on each row: the one DOM fact selection readers use (`diffTextSelection`). */
function codeLineDomDataSet(line: CodeLine): Readonly<Record<string, string>> {
    return {
        codeLineKind: line.kind,
        ...(line.oldLine !== null ? { codeLineOld: String(line.oldLine) } : {}),
        ...(line.newLine !== null ? { codeLineNew: String(line.newLine) } : {}),
    };
}
const VIRTUALIZED_LIST_STYLE = { flex: 1, minHeight: 0 } as const;
const LIST_FOOTER_STYLE = { height: 16 } as const;

type CodePointerEvent = Readonly<{
    target?: unknown;
    clientX?: number;
    clientY?: number;
    metaKey?: boolean;
    ctrlKey?: boolean;
    pointerType?: string;
    nativeEvent?: Readonly<{ clientX?: number; clientY?: number; metaKey?: boolean; ctrlKey?: boolean; pointerType?: string }>;
}>;

function resolvePointerToken(event: CodePointerEvent, lines: ReadonlyMap<string, CodeLine>) {
    if (typeof document === 'undefined') return null;
    const target = event.target;
    if (!target || typeof target !== 'object' || !('closest' in target) || typeof target.closest !== 'function') return null;
    const code = target.closest('[data-code-text]') as Element | null;
    const id = code?.getAttribute('data-code-text');
    const line = id ? lines.get(id) : null;
    if (!code || !line || line.renderIsHeaderLine || line.newLine === null || line.kind === 'remove') return null;
    const x = event.clientX ?? event.nativeEvent?.clientX;
    const y = event.clientY ?? event.nativeEvent?.clientY;
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    const caretDocument = document as Document & {
        caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
        caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = caretDocument.caretPositionFromPoint?.(x, y);
    const caretRange = position ? null : caretDocument.caretRangeFromPoint?.(x, y);
    const node = position?.offsetNode ?? caretRange?.startContainer;
    const offset = position?.offset ?? caretRange?.startOffset;
    if (!node || offset === undefined || !code.contains(node)) return null;
    const range = document.createRange();
    range.selectNodeContents(code);
    range.setEnd(node, offset);
    const box = 'getBoundingClientRect' in code && typeof code.getBoundingClientRect === 'function' ? code.getBoundingClientRect() : null;
    return { lineId: line.id, newLine: line.newLine, offset16: Math.min(line.renderCodeText.length, range.toString().length),
        rect: box ? { x, y: box.top, width: 1, height: box.height } : null };
}

function preventNativeTextSelection(event?: PreventableEvent): void {
    event?.preventDefault?.();
    event?.nativeEvent?.preventDefault?.();
}

export function CodeLinesViewCore(
    props: CodeLinesViewProps & Readonly<{
        getAdvancedTokens?: (index: number) => readonly InlineToken[] | null | undefined;
        advancedTokensRevision?: number;
    }>
) {
    const lineRefs = React.useRef(new Map<string, View>());
    const externalRowLayouts = React.useRef(new Map<string, { y: number; height: number }>());
    const measureExternalRow = React.useCallback((id: string) => {
        const owner = props.externalScrollView;
        const row = lineRefs.current.get(id);
        if (Platform.OS === 'web' || !owner || !row) return;
        measureExternalLayout(owner, row, (_x, y, _width, height) => {
            if (lineRefs.current.get(id) === row) externalRowLayouts.current.set(id, { y, height });
        });
    }, [props.externalScrollView]);
    const lineNativeIdPrefix = React.useId();
    const completedScrollTarget = React.useRef<string | null>(null);
    const contentRef = React.useRef<View | null>(null);
    const nativeReadingAnchor = React.useRef<NativeCodeReadingAnchor | null>(null);
    const pendingReadingScroll = React.useRef<NativeCodeReadingAnchor | null>(null);
    const nativeScrollOffset = React.useRef(0);
    const readingLinesRef = React.useRef(props.lines);
    readingLinesRef.current = props.lines;
    const measureNativeReadingAnchor = React.useCallback(() => {
        if (Platform.OS === 'web') return;
        const anchor = nativeReadingAnchor.current;
        if (!anchor) return;
        const lines = readingLinesRef.current;
        const line = lines[anchor.index];
        const row = line ? lineRefs.current.get(line.id) : null;
        const scrollView = listRef.current?.getNativeScrollRef?.();
        if (!row || !scrollView || !('measureInWindow' in scrollView)) return;
        scrollView.measureInWindow((_x, viewportY) => {
            row.measureInWindow((_rowX, rowY) => {
                if (nativeReadingAnchor.current !== anchor || readingLinesRef.current !== lines) return;
                nativeReadingAnchor.current = { index: anchor.index, offset: rowY - viewportY };
            });
        });
    }, []);
    const onViewableItemsChanged = React.useCallback(({ viewableItems }: { viewableItems: Array<{ index: number | null }> }) => {
        const index = viewableItems.find((item) => item.index !== null)?.index;
        if (index !== undefined && index !== null) {
            nativeReadingAnchor.current = { index, offset: 0 };
            measureNativeReadingAnchor();
        }
    }, [measureNativeReadingAnchor]);
    const selected = props.selectedLineIds ?? EMPTY_LINE_ID_SET;
    const paddingHorizontal = props.contentPaddingHorizontal ?? 0;
    const paddingVertical = props.contentPaddingVertical ?? 0;
    const wrapLines = props.wrapLines ?? true;
    const virtualized = props.virtualized ?? true;
    const showLineNumbers = props.showLineNumbers ?? true;
    const lineNumberDigits = React.useMemo(() => Math.max(props.lineNumberDigits ?? 1, props.lines.reduce(
        (digits, line) => Math.max(digits, String(Math.max(line.oldLine ?? 0, line.newLine ?? 0)).length), 1,
    )), [props.lineNumberDigits, props.lines]);
    const reviewLaneWidth = React.useMemo(() => props.reviewLaneWidth ?? (
        props.onPressAddComment && (props.showInactiveCommentAffordance !== false || props.lines.some(line => props.isCommentActive?.(line)))
            ? CODE_GUTTER_METRICS.reviewLaneWidth : 0
    ), [props.reviewLaneWidth, props.onPressAddComment, props.showInactiveCommentAffordance, props.lines, props.isCommentActive]);
    const showPrefix = props.showPrefix ?? true;
    const advancedTokensRevision = props.advancedTokensRevision ?? 0;
    const interactionMode = props.interactionMode ?? 'read';
    const onPressLine = props.onPressLine;
    const onPressLineRange = props.onPressLineRange;
    const rangeSelectionActive = props.rangeSelectionActive;
    const rangeGesturesEnabled = interactionMode !== 'read' && typeof onPressLineRange === 'function';
    const intelligenceEnabled = props.intelligence !== undefined;
    const intelligenceLines = React.useMemo(() => intelligenceEnabled
        ? new Map(props.lines.map((line) => [line.id, line])) : null, [intelligenceEnabled, props.lines]);
    const onPointerToken = props.intelligence?.onPointerToken;
    const onActivateToken = props.intelligence?.onActivateToken;
    const onPointerAway = props.intelligence?.onPointerAway;
    const diagnosticsByNewLine = props.intelligence?.diagnosticsByNewLine;
    const handlePointerMove = React.useCallback((event: CodePointerEvent) => {
        if ((event.pointerType ?? event.nativeEvent?.pointerType) === 'touch') return;
        const token = intelligenceLines ? resolvePointerToken(event, intelligenceLines) : null;
        if (token) onPointerToken?.(token.lineId, token.offset16, token.rect, token.newLine);
        else onPointerAway?.();
    }, [intelligenceLines, onPointerAway, onPointerToken]);
    const handleTokenClick = React.useCallback((event: CodePointerEvent) => {
        if (!(event.metaKey || event.ctrlKey || event.nativeEvent?.metaKey || event.nativeEvent?.ctrlKey)) return;
        const token = intelligenceLines ? resolvePointerToken(event, intelligenceLines) : null;
        if (token) onActivateToken?.(token.lineId, token.offset16, { via: 'modifier', rect: token.rect }, token.newLine);
    }, [intelligenceLines, onActivateToken]);
    const handleTokenTouch = React.useCallback((event: CodePointerEvent) => {
        if ((event.pointerType ?? event.nativeEvent?.pointerType) !== 'touch' || rangeGesturesEnabled) return;
        if (typeof window !== 'undefined' && window.getSelection?.()?.isCollapsed === false) return;
        const token = intelligenceLines ? resolvePointerToken(event, intelligenceLines) : null;
        if (token) onActivateToken?.(token.lineId, token.offset16, { via: 'touch', rect: token.rect }, token.newLine);
    }, [intelligenceLines, onActivateToken, rangeGesturesEnabled]);
    // Native rows resolve a tap themselves (tap-to-name); they report no anchor rect.
    const onRowActivateToken = React.useCallback((lineId: string, offset16: number) => {
        const newLine = intelligenceLines?.get(lineId)?.newLine;
        if (typeof newLine === 'number') onActivateToken?.(lineId, offset16, { via: 'touch', rect: null }, newLine);
    }, [intelligenceLines, onActivateToken]);
    const intelligenceEvents = Platform.OS === 'web' && props.intelligence
        ? { onPointerMove: handlePointerMove, onPointerLeave: onPointerAway } : {};
    // Rows are Pressables, whose click handler stops propagation; read clicks and taps in the capture phase
    // (rows carry `${lineNativeIdPrefix}-<line id>` as their DOM id), without taking the press from them.
    const tokenClickRef = React.useRef(handleTokenClick);
    tokenClickRef.current = handleTokenClick;
    const tokenTouchRef = React.useRef(handleTokenTouch);
    tokenTouchRef.current = handleTokenTouch;
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !intelligenceEnabled || typeof document === 'undefined') return;
        const rowSelector = `[id^="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(lineNativeIdPrefix) : lineNativeIdPrefix}-"]`;
        const owns = (target: EventTarget | null) => typeof Element !== 'undefined' && target instanceof Element && target.closest(rowSelector) !== null;
        const onClick = (event: MouseEvent) => { if (owns(event.target)) tokenClickRef.current(event as unknown as CodePointerEvent); };
        const onPointerUp = (event: PointerEvent) => { if (owns(event.target)) tokenTouchRef.current(event as unknown as CodePointerEvent); };
        document.addEventListener('click', onClick, true);
        document.addEventListener('pointerup', onPointerUp, true);
        return () => {
            document.removeEventListener('click', onClick, true);
            document.removeEventListener('pointerup', onPointerUp, true);
        };
    }, [intelligenceEnabled, lineNativeIdPrefix]);
    const lastPressedLineIdRef = React.useRef<string | null>(null);
    const explicitRangeStartLineIdRef = React.useRef<string | null>(null);
    const dragStartLineIdRef = React.useRef<string | null>(null);
    const dragCurrentLineIdRef = React.useRef<string | null>(null);

    const effectiveSyntaxHighlighting = React.useMemo(() => {
        return resolveEffectiveSyntaxHighlighting({ lines: props.lines, config: props.syntaxHighlighting });
    }, [props.lines, props.syntaxHighlighting]);

    const isHighlighted = React.useCallback((lineId: string) => {
        return props.highlightLineId === lineId || props.highlightLineIds?.has(lineId) === true;
    }, [props.highlightLineId, props.highlightLineIds]);

    const resolveRange = React.useCallback((startLineId: string, endLineId: string): readonly CodeLine[] => {
        return resolveCodeLineRangeSelection({
            lines: props.lines,
            startLineId,
            endLineId,
            includeLine: (line) => !line.renderIsHeaderLine,
        });
    }, [props.lines]);

    const completeRange = React.useCallback((startLineId: string, endLineId: string) => {
        const range = resolveRange(startLineId, endLineId);
        if (range.length === 0) return;
        onPressLineRange?.(range);
    }, [onPressLineRange, resolveRange]);

    const handlePressLine = React.useCallback((line: CodeLine, event?: CodeLinePressEvent) => {
        if (!rangeGesturesEnabled) {
            lastPressedLineIdRef.current = line.id;
            onPressLine?.(line, event);
            return;
        }

        if (rangeSelectionActive === true) {
            const startLineId = explicitRangeStartLineIdRef.current;
            if (!startLineId) {
                explicitRangeStartLineIdRef.current = line.id;
                lastPressedLineIdRef.current = line.id;
                return;
            }
            explicitRangeStartLineIdRef.current = null;
            lastPressedLineIdRef.current = line.id;
            completeRange(startLineId, line.id);
            return;
        }

        const shiftPressed = event?.shiftKey === true || event?.nativeEvent?.shiftKey === true;
        const startLineId = lastPressedLineIdRef.current;
        if (shiftPressed && startLineId) {
            lastPressedLineIdRef.current = line.id;
            completeRange(startLineId, line.id);
            return;
        }

        lastPressedLineIdRef.current = line.id;
        onPressLine?.(line, event);
    }, [completeRange, onPressLine, rangeGesturesEnabled, rangeSelectionActive]);

    const handlePressInLine = React.useCallback((line: CodeLine, event?: PreventableEvent) => {
        if (!rangeGesturesEnabled || Platform.OS !== 'web') return;
        preventNativeTextSelection(event);
        dragStartLineIdRef.current = line.id;
        dragCurrentLineIdRef.current = line.id;
    }, [rangeGesturesEnabled]);

    const handleHoverLine = React.useCallback((line: CodeLine, event?: PreventableEvent) => {
        if (!rangeGesturesEnabled || Platform.OS !== 'web') return;
        if (!dragStartLineIdRef.current) return;
        preventNativeTextSelection(event);
        dragCurrentLineIdRef.current = line.id;
    }, [rangeGesturesEnabled]);

    const handlePressOutLine = React.useCallback((line: CodeLine, event?: PreventableEvent) => {
        if (!rangeGesturesEnabled || Platform.OS !== 'web') return;
        preventNativeTextSelection(event);
        const startLineId = dragStartLineIdRef.current;
        const endLineId = dragCurrentLineIdRef.current ?? line.id;
        dragStartLineIdRef.current = null;
        dragCurrentLineIdRef.current = null;
        if (!startLineId || startLineId === endLineId) return;
        completeRange(startLineId, endLineId);
    }, [completeRange, rangeGesturesEnabled]);

    const renderLine = React.useCallback((item: CodeLine, index: number) => (
        <View
            collapsable={false}
            nativeID={`${lineNativeIdPrefix}-${item.id}`}
            // A text selection inside the row reads its line from here (Ask about a selection, web).
            {...(Platform.OS === 'web' ? { dataSet: codeLineDomDataSet(item) } : {})}
            onLayout={props.externalScrollView ? () => measureExternalRow(item.id) : undefined}
            ref={(node) => {
                if (node) lineRefs.current.set(item.id, node);
                else lineRefs.current.delete(item.id);
            }}
        >
            {/* A blanked header (a review separator with no hidden lines) keeps only its slot below. */}
            {item.renderIsHeaderLine && item.renderCodeText === '' ? null : <CodeLineRow
                line={item}
                lineNumberDigits={lineNumberDigits}
                reviewLaneWidth={reviewLaneWidth}
                leadingLane={props.renderLeadingLane?.(item)}
                selected={selected.has(item.id)}
                highlighted={isHighlighted(item.id)}
                reviewed={props.reviewedLineIds?.has(item.id) === true}
                liveTintOpacity={props.liveTint?.lineIds.has(item.id) ? props.liveTint.opacity : undefined}
                findRanges={props.findRangesByLineId?.get(item.id)}
                diagnostics={item.kind !== 'remove' && typeof item.newLine === 'number' ? diagnosticsByNewLine?.get(item.newLine) : undefined}
                onActivateToken={rangeGesturesEnabled || !onActivateToken ? undefined : onRowActivateToken}
                onPressLine={handlePressLine}
                onPressInLine={rangeGesturesEnabled && Platform.OS === 'web' ? handlePressInLine : undefined}
                onHoverLine={rangeGesturesEnabled && Platform.OS === 'web' ? handleHoverLine : undefined}
                onPressOutLine={rangeGesturesEnabled && Platform.OS === 'web' ? handlePressOutLine : undefined}
                pressLineWhenNotSelectable={props.pressLineWhenNotSelectable}
                onPressAddComment={props.onPressAddComment}
                commentActive={props.isCommentActive ? props.isCommentActive(item) : false}
                showInactiveCommentAffordance={props.showInactiveCommentAffordance}
                wrapLines={wrapLines}
                showLineNumbers={showLineNumbers}
                showPrefix={showPrefix}
                syntaxHighlighting={effectiveSyntaxHighlighting}
                advancedTokens={effectiveSyntaxHighlighting.mode === 'advanced' ? (props.getAdvancedTokens?.(index) ?? undefined) : undefined}
            />}
            {props.renderAfterLine ? props.renderAfterLine(item) : null}
        </View>
    ), [
        lineNumberDigits,
        reviewLaneWidth,
        lineNativeIdPrefix,
        measureExternalRow,
        props.externalScrollView,
        props.findRangesByLineId,
        diagnosticsByNewLine,
        onActivateToken,
        onRowActivateToken,
        effectiveSyntaxHighlighting,
        handleHoverLine,
        handlePressInLine,
        handlePressLine,
        handlePressOutLine,
        isHighlighted,
        props.reviewedLineIds,
        props.liveTint,
        props.getAdvancedTokens,
        props.isCommentActive,
        props.onPressAddComment,
        props.pressLineWhenNotSelectable,
        props.renderAfterLine,
        props.renderLeadingLane,
        props.showInactiveCommentAffordance,
        rangeGesturesEnabled,
        selected,
        showLineNumbers,
        showPrefix,
        wrapLines,
    ]);

    const renderItem = React.useCallback(({ item, index }: { item: CodeLine; index: number }) => {
        return renderLine(item, index);
    }, [renderLine]);

    const contentContainerStyle = React.useMemo(() => ({
        paddingHorizontal,
        paddingVertical,
    }), [paddingHorizontal, paddingVertical]);

    const listFooterComponent = React.useMemo(() => <View style={LIST_FOOTER_STYLE} />, []);

    const listRef = React.useRef<FlatList<CodeLine> | null>(null);

    const scrollIndex = React.useMemo(() => {
        const id = props.scrollToLineId;
        if (!id) return -1;
        return props.lines.findIndex((l) => l.id === id);
    }, [props.lines, props.scrollToLineId]);

    const estimatedRowHeight = CODE_LINE_BASE_HEIGHT;
    // Two occurrences can share a line. Their range is the navigation identity, while equivalent
    // decoration refreshes retain the completed target and leave manual reading scroll untouched.
    const scrollTargetKey = codeLineScrollTargetKey(props.scrollToLineId, props.scrollToLineId ? props.findRangesByLineId?.get(props.scrollToLineId) : undefined);

    const getItemLayout = React.useCallback((_: unknown, index: number) => {
        // A best-effort constant-height layout to make scroll-to-index reliable on React Native Web.
        // If a line wraps, the offset can be slightly off, but the highlight still guides the user.
        return {
            length: estimatedRowHeight,
            offset: estimatedRowHeight * index,
            index,
        };
    }, [estimatedRowHeight]);

    React.useEffect(() => {
        const targetId = props.scrollToLineId;
        if (!targetId) {
            completedScrollTarget.current = null;
            return;
        }
        if (scrollIndex < 0 || completedScrollTarget.current === scrollTargetKey) return;
        const firstLineId = props.lines[0]?.id ?? null;

        let cancelled = false;

        const tryScrollIntoView = (): boolean => {
            if (typeof document === 'undefined') return false;
            // React Native Web maps `nativeID` to DOM `id`.
            const el = (document as any)?.getElementById?.(`${lineNativeIdPrefix}-${targetId}`);
            if (!el) return false;
            if (typeof el.scrollIntoView !== 'function') return false;
            try {
                el.scrollIntoView({ block: 'center' });
                return true;
            } catch {
                return false;
            }
        };

        const tryScrollDomOffset = (): boolean => {
            if (typeof document === 'undefined') return false;
            const doc: any = document as any;
            const fallbackAnchor = doc?.getElementById?.(`${lineNativeIdPrefix}-${targetId}`)
                ?? (firstLineId ? doc?.getElementById?.(`${lineNativeIdPrefix}-${firstLineId}`) : null);
            if (!fallbackAnchor) return false;

            let el = fallbackAnchor.parentElement;
            let steps = 0;
            while (el && steps < 30) {
                const overflowY = (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function')
                    ? window.getComputedStyle(el).overflowY
                    : null;
                const overflowOk = overflowY ? (overflowY === 'auto' || overflowY === 'scroll') : true;
                if (overflowOk && el.scrollHeight > el.clientHeight + 5) {
                    const top = estimatedRowHeight * scrollIndex;
                    try {
                        if (typeof el.scrollTo === 'function') {
                            el.scrollTo({ top });
                        } else {
                            el.scrollTop = top;
                        }
                    } catch {
                        try {
                            el.scrollTop = estimatedRowHeight * scrollIndex;
                        } catch {
                            // ignore
                        }
                    }
                    return true;
                }
                el = el.parentElement;
                steps++;
            }

            return false;
        };

        const attemptScroll = () => {
            if (cancelled) return;
            pendingReadingScroll.current = null;
            pendingReadingScroll.current = null;
            if (!virtualized && typeof document === 'undefined') {
                const row = lineRefs.current.get(targetId);
                const owner = props.externalScrollView;
                if (row && owner) {
                    measureExternalLayout(owner, row, (_x, y) => {
                        if (cancelled) return;
                        const scrollY = Math.max(0, y);
                        completedScrollTarget.current = scrollTargetKey;
                        owner.offsetRef.current = scrollY;
                        owner.scrollRef.current?.scrollTo({ y: scrollY, animated: true });
                    });
                    return;
                }
                if (!props.onScrollToLine) return;
                row?.measureInWindow((_x, y) => {
                    if (cancelled) return;
                    completedScrollTarget.current = scrollTargetKey;
                    props.onScrollToLine?.(y);
                });
                return;
            }
            // Defer until after layout to avoid "no item at index" on first paint.
            try {
                if (listRef.current) {
                    listRef.current.scrollToIndex({ index: scrollIndex, viewPosition: 0.25, animated: true });
                    completedScrollTarget.current = scrollTargetKey;
                }
            } catch {
                // ignore
            }
            // React Native Web sometimes fails to forward FlatList refs; fall back to DOM scrollTop.
            const offsetScrolled = tryScrollDomOffset();
            if (tryScrollIntoView() || offsetScrolled) completedScrollTarget.current = scrollTargetKey;
        };

        let attempts = 0;
        let timer: any = null;
        const tick = () => {
            attempts += 1;
            attemptScroll();
            if (cancelled) return;
            // Retry briefly to catch layout + virtualization rendering on web.
            if (attempts < 6 && typeof document !== 'undefined') {
                timer = setTimeout(tick, 50);
            }
        };

        timer = setTimeout(tick, 0);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [estimatedRowHeight, lineNativeIdPrefix, props.lines, props.externalScrollView, props.onScrollToLine, props.scrollToLineId, scrollTargetKey, scrollIndex, virtualized]);

    // FlatList is a PureComponent: when behavior depends on props outside `data`, we must provide `extraData`
    // to ensure rows get re-rendered. This matters for "selected" state and inline review-comment composers.
    const listExtraData = React.useMemo(() => ({
        lineNumberDigits,
        reviewLaneWidth,
        selectedLineIds: props.selectedLineIds,
        renderAfterLine: props.renderAfterLine,
        renderLeadingLane: props.renderLeadingLane,
        onPressLine: handlePressLine,
        onPressInLine: rangeGesturesEnabled && Platform.OS === 'web' ? handlePressInLine : undefined,
        onHoverLine: rangeGesturesEnabled && Platform.OS === 'web' ? handleHoverLine : undefined,
        onPressOutLine: rangeGesturesEnabled && Platform.OS === 'web' ? handlePressOutLine : undefined,
        interactionMode,
        rangeSelectionActive: props.rangeSelectionActive,
        onPressLineRange: props.onPressLineRange,
        pressLineWhenNotSelectable: props.pressLineWhenNotSelectable,
        onPressAddComment: props.onPressAddComment,
        isCommentActive: props.isCommentActive,
        showInactiveCommentAffordance: props.showInactiveCommentAffordance,
        wrapLines,
        showLineNumbers,
        showPrefix,
        syntaxHighlighting: effectiveSyntaxHighlighting,
        highlightLineId: props.highlightLineId,
        highlightLineIds: props.highlightLineIds,
        reviewedLineIds: props.reviewedLineIds,
        liveTint: props.liveTint,
        findRangesByLineId: props.findRangesByLineId,
        diagnosticsByNewLine,
        advancedTokensRevision,
    } as const), [
        lineNumberDigits,
        reviewLaneWidth,
        effectiveSyntaxHighlighting,
        advancedTokensRevision,
        handleHoverLine,
        handlePressInLine,
        handlePressLine,
        handlePressOutLine,
        interactionMode,
        rangeGesturesEnabled,
        props.highlightLineId,
        props.highlightLineIds,
        props.reviewedLineIds,
        props.liveTint,
        props.findRangesByLineId,
        diagnosticsByNewLine,
        props.isCommentActive,
        props.onPressAddComment,
        props.onPressLineRange,
        props.pressLineWhenNotSelectable,
        props.showInactiveCommentAffordance,
        props.rangeSelectionActive,
        props.renderAfterLine,
        props.renderLeadingLane,
        props.selectedLineIds,
        showLineNumbers,
        showPrefix,
        wrapLines,
    ]);

    const preserveReadingAnchor = (children: React.ReactNode) => (
        <CodeLinesReadingAnchor
            lines={props.lines}
            viewId={lineNativeIdPrefix}
            scrollToLineId={props.scrollToLineId}
            getRoot={() => virtualized ? listRef.current?.getNativeScrollRef?.() : contentRef.current}
            nativeAnchor={Platform.OS === 'web' ? undefined : nativeReadingAnchor}
            getNativeAnchor={!virtualized && props.externalScrollView ? (lines) => {
                const scrollY = props.externalScrollView!.offsetRef.current;
                const first = lines[0] ? externalRowLayouts.current.get(lines[0].id) : null;
                // Inline siblings share one viewport: only its top passage owns restoration.
                if (!first || scrollY < first.y) return null;
                const index = lines.findIndex((line) => {
                    const layout = externalRowLayouts.current.get(line.id);
                    return layout !== undefined && layout.y + layout.height > scrollY;
                });
                const layout = index >= 0 ? externalRowLayouts.current.get(lines[index].id) : null;
                return layout ? { index, offset: layout.y - scrollY } : null;
            } : undefined}
            scrollToIndex={virtualized ? (index, offset) => {
                pendingReadingScroll.current = { index, offset };
                const lines = props.lines;
                const target = lines[index];
                const row = target ? lineRefs.current.get(target.id) : null;
                const scrollView = listRef.current?.getNativeScrollRef?.();
                if (Platform.OS !== 'web' && row && scrollView && 'measureInWindow' in scrollView) {
                    scrollView.measureInWindow((_x, viewportY) => {
                        row.measureInWindow((_rowX, rowY) => {
                            if (readingLinesRef.current !== lines) return;
                            const nextOffset = Math.max(0, nativeScrollOffset.current + rowY - viewportY - offset);
                            nativeScrollOffset.current = nextOffset;
                            listRef.current?.scrollToOffset({ offset: nextOffset, animated: false });
                        });
                    });
                } else {
                    listRef.current?.scrollToIndex({ index, viewOffset: offset, animated: false });
                }
            } : props.externalScrollView ? (index, offset) => {
                const owner = props.externalScrollView;
                const line = props.lines[index];
                const row = line ? lineRefs.current.get(line.id) : null;
                if (!owner || !row || !line) return;
                measureExternalLayout(owner, row, (_x, y, _width, height) => {
                    if (readingLinesRef.current !== props.lines) return;
                    externalRowLayouts.current.set(line.id, { y, height });
                    const scrollY = Math.max(0, y - offset);
                    owner.offsetRef.current = scrollY;
                    owner.scrollRef.current?.scrollTo({ y: scrollY, animated: false });
                });
            } : undefined}
        >
            {children}
        </CodeLinesReadingAnchor>
    );

    if (!virtualized) {
        return preserveReadingAnchor(
            <View ref={contentRef} style={{ paddingHorizontal, paddingVertical }} {...intelligenceEvents}>
                {props.lines.map((line, index) => (
                    <React.Fragment key={line.id}>
                        {renderLine(line, index)}
                    </React.Fragment>
                ))}
                <View style={{ height: 16 }} />
            </View>
        );
    }

    return preserveReadingAnchor(
        <FlatList
            {...intelligenceEvents}
            ref={(node) => {
                // react-test-renderer does not provide a stable ref object; we store it manually.
                listRef.current = node as any;
            }}
            data={props.lines as CodeLine[]}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            extraData={listExtraData}
            testID={props.testID}
            style={VIRTUALIZED_LIST_STYLE}
            disableVirtualization={!virtualized}
            initialScrollIndex={scrollIndex >= 0 ? scrollIndex : undefined}
            getItemLayout={wrapLines ? undefined : getItemLayout}
            contentContainerStyle={contentContainerStyle}
            ListFooterComponent={listFooterComponent}
            onLayout={props.onLayout}
            onContentSizeChange={props.onContentSizeChange}
            onViewableItemsChanged={onViewableItemsChanged}
            onScroll={(event) => {
                nativeScrollOffset.current = event.nativeEvent.contentOffset.y;
                measureNativeReadingAnchor();
                props.onScroll?.(event);
            }}
            scrollEventThrottle={props.scrollEventThrottle}
            onScrollToIndexFailed={(info) => {
                const readingTarget = pendingReadingScroll.current?.index === info.index ? pendingReadingScroll.current : null;
                pendingReadingScroll.current = null;
                // Best-effort retry: FlatList can fail if measurement hasn't completed yet.
                try {
                    listRef.current?.scrollToOffset({
                        offset: info.averageItemLength * info.index - (readingTarget?.offset ?? 0),
                        animated: !readingTarget,
                    });
                } catch {
                    // ignore
                }
                setTimeout(() => {
                    try {
                        listRef.current?.scrollToIndex(readingTarget
                            ? { index: info.index, viewOffset: readingTarget.offset, animated: false }
                            : { index: info.index, viewPosition: 0.25, animated: true });
                    } catch {
                        // ignore
                    }
                }, 50);
            }}
        />
    );
}
