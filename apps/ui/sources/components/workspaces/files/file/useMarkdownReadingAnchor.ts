import * as React from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollView } from 'react-native';
import type { MarkdownSourceRangeAction, MarkdownSourceRangeLayoutObserver } from '@/components/markdown/MarkdownView';
import { mapCodeReadingAnchor, mapCodeReadingAnchors } from '@/components/ui/code/model/mapCodeReadingAnchor';

type Layout = Readonly<{ y: number; height: number }>;
/** A measured offset inside a range, or a source line inside it whose offset waits for the range's layout. */
type Anchor = Readonly<{ index: number; offset: number; line?: undefined } | { index: number; line: number; offset?: undefined }>;

/** Where `line` sits inside a measured range that may span several source lines (a native prose run). */
function offsetOfLine(range: MarkdownSourceRangeAction, layout: Layout, line: number): number {
    const lines = range.sourceRange.endLine - range.sourceRange.startLine + 1;
    return Math.max(0, Math.min(1, (line - range.sourceRange.startLine) / lines)) * layout.height;
}

function lineAtOffset(range: MarkdownSourceRangeAction, layout: Layout | undefined, offset: number): number {
    const { startLine, endLine } = range.sourceRange;
    if (!layout || layout.height <= 0) return startLine;
    return Math.min(endLine, startLine + Math.floor(Math.max(0, offset / layout.height) * (endLine - startLine + 1)));
}

/**
 * The Markdown renderer measures its own segments; the file preview remains the only scroll owner.
 * `run` granularity keeps native prose one selectable text view and maps lines inside a run by its height.
 */
export function useMarkdownReadingAnchor(identity: string, paddingTop: number, initialLine?: number, granularity: 'block' | 'run' = 'block') {
    const scrollRef = React.useRef<ScrollView>(null);
    const state = React.useMemo(() => ({
        ranges: [] as readonly MarkdownSourceRangeAction[],
        indices: new Map<number, number>(),
        layouts: new Map<number, Layout>(),
        anchor: null as Anchor | null,
        pending: false,
        anchorMeasured: false,
        scrollY: 0,
        /** The offset the scroll view last reported, as opposed to `scrollY`, the offset this owner wants. */
        reportedY: 0,
        requestedY: null as number | null,
        requestedLine: (initialLine ?? null) as number | null,
        /** A remembered line lands inside its range; a Find target reveals its block's start. */
        requestedWithin: initialLine !== undefined,
        rangesGranularity: granularity,
    }), [identity]);
    const readAnchorLine = React.useCallback((): number | null => {
        const anchor = state.anchor;
        const range = anchor ? state.ranges[anchor.index] : undefined;
        if (!anchor || !range) return null;
        return anchor.line ?? lineAtOffset(range, state.layouts.get(anchor.index), anchor.offset);
    }, [state]);
    const restore = React.useCallback(() => {
        if (!state.pending || !state.anchor || !state.anchorMeasured) return;
        const layout = state.layouts.get(state.anchor.index);
        const range = state.ranges[state.anchor.index];
        if (!layout || !range) return;
        const offset = state.anchor.line === undefined ? state.anchor.offset : offsetOfLine(range, layout, state.anchor.line);
        const y = Math.max(0, paddingTop + layout.y + Math.min(offset, layout.height));
        if (y === state.scrollY) return;
        state.requestedY = y;
        state.scrollY = y;
        scrollRef.current?.scrollTo({ y, animated: false });
    }, [paddingTop, state]);
    const revealRequestedLine = React.useCallback(() => {
        if (state.requestedLine === null) return;
        const index = state.ranges.findIndex((range) => range.sourceRange.startLine <= state.requestedLine!
            && range.sourceRange.endLine >= state.requestedLine!);
        if (index < 0) return;
        state.anchor = state.requestedWithin ? { index, line: state.requestedLine } : { index, offset: 0 };
        state.pending = true;
        state.anchorMeasured = state.layouts.has(index);
        if (state.anchorMeasured) { state.requestedLine = null; restore(); }
    }, [restore, state]);
    const observer = React.useMemo<MarkdownSourceRangeLayoutObserver>(() => ({
        granularity,
        onRanges: (ranges) => {
            if (state.ranges === ranges) return;
            if (state.anchor && state.ranges.length > 0 && state.rangesGranularity !== granularity) {
                // Runs and blocks share no passages to match by content (native Find opening or closing): keep the source line.
                const line = readAnchorLine();
                state.anchor = null;
                state.pending = false;
                if (line !== null && state.requestedLine === null) {
                    state.requestedLine = line;
                    state.requestedWithin = true;
                }
            } else if (state.anchor && state.ranges.length > 0) {
                const index = mapCodeReadingAnchor(state.ranges.map((range) => range.markdown), ranges.map((range) => range.markdown), state.anchor.index);
                state.anchor = index < 0 ? null : { ...state.anchor, index };
                state.pending = state.anchor !== null;
            }
            state.rangesGranularity = granularity;
            const previousLayouts = [...state.layouts];
            const mapped = mapCodeReadingAnchors(state.ranges.map((range) => range.markdown), ranges.map((range) => range.markdown), previousLayouts.map(([index]) => index));
            state.layouts = new Map(previousLayouts.flatMap(([, layout], position) => {
                const index = mapped[position];
                return index === null || index === undefined ? [] : [[index, layout] as const];
            }));
            state.anchorMeasured = false;
            state.ranges = ranges;
            state.indices = new Map(ranges.map((range, index) => [range.sourceRange.startLine, index]));
            revealRequestedLine();
        },
        onLayout: (range, layout) => {
            const index = state.indices.get(range.sourceRange.startLine);
            if (index === undefined || state.ranges[index]?.markdown !== range.markdown) return;
            state.layouts.set(index, layout);
            if (state.anchor?.index === index) state.anchorMeasured = true;
            revealRequestedLine();
            restore();
        },
    }), [granularity, readAnchorLine, restore, revealRequestedLine, state]);
    const onScroll = React.useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
        const y = contentOffset.y;
        const moved = Math.abs(y - state.reportedY) >= 1;
        state.reportedY = y;
        if (state.requestedY !== null && Math.abs(y - state.requestedY) < 1) {
            state.requestedY = null;
            state.scrollY = y;
            return;
        }
        // Web reports a scroll on its tick and again when scrolling ends: an offset reported again is not the reader moving.
        if (!moved) return;
        const maxY = contentSize && layoutMeasurement ? Math.max(0, contentSize.height - layoutMeasurement.height) : null;
        if (state.anchor && maxY !== null && Math.abs(y - maxY) < 1 && y < (state.requestedY ?? state.scrollY) - 1) {
            // The page is shorter than the passage (images loading, a hidden tab laying out again) and clamped the
            // offset: that is not the reader moving, so hold the passage and restore it as the page grows.
            state.scrollY = y;
            state.pending = true;
            return;
        }
        state.requestedY = null;
        state.pending = false;
        state.requestedLine = null;
        state.requestedWithin = false;
        state.scrollY = y;
        let index = -1;
        let closestY = -Infinity;
        for (const [candidate, layout] of state.layouts) {
            if (layout.y <= y - paddingTop && layout.y > closestY) {
                index = candidate;
                closestY = layout.y;
            }
        }
        state.anchor = index < 0 ? null : { index, offset: y - paddingTop - closestY };
    }, [paddingTop, state]);
    React.useLayoutEffect(() => {
        scrollRef.current?.scrollTo({ y: 0, animated: false });
    }, [state]);
    const revealLine = React.useCallback((line: number) => {
        state.requestedLine = line;
        state.requestedWithin = false;
        revealRequestedLine();
    }, [revealRequestedLine, state]);
    const readLine = readAnchorLine;
    return { scrollRef, observer, onScroll, onContentSizeChange: restore, revealLine, readLine };
}
