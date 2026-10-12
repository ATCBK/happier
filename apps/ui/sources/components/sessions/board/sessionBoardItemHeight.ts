import type { SessionSurfaceItemV1 } from '@happier-dev/protocol/sessions/board';

/**
 * Semantic item heights.
 *
 * The Board persists intent (`compact | regular | tall`), never pixels, so the same
 * item reads coherently on a phone and a wide desktop pane. These are presentation
 * tokens for that intent; the host's own measured minimum/maximum always clamps
 * them, and a renderer height report only ever narrows an `auto` item.
 */
export const SESSION_BOARD_SEMANTIC_HEIGHTS: Readonly<Record<'compact' | 'regular' | 'tall', number>> = Object.freeze({
    compact: 160,
    regular: 280,
    tall: 440,
});

export type SessionBoardHeightBounds = Readonly<{ min: number; max: number }>;

export type SessionBoardResolvedHeight = Readonly<{
    height: number;
    /** `measured` only when a live renderer report was actually used. */
    source: 'measured' | 'semantic';
}>;

function clamp(value: number, bounds: SessionBoardHeightBounds): number {
    const min = Math.min(bounds.min, bounds.max);
    const max = Math.max(bounds.min, bounds.max);
    return Math.min(Math.max(value, min), max);
}

/**
 * Resolve the rendered height for one placement.
 *
 * `auto` consumes a bounded renderer height report and clamps it to the host's
 * measured range. Before any measurement, on a host that cannot measure, and after
 * a report expires it uses the stored semantic fallback, so content never collapses
 * to nothing while waiting. `fixed` ignores renderer reports entirely.
 */
export function resolveSessionBoardItemHeight(input: Readonly<{
    height: SessionSurfaceItemV1['height'];
    reportedHeight?: number | null;
    bounds: SessionBoardHeightBounds;
}>): SessionBoardResolvedHeight {
    if (input.height.mode === 'fixed') {
        return Object.freeze({
            height: clamp(SESSION_BOARD_SEMANTIC_HEIGHTS[input.height.size], input.bounds),
            source: 'semantic' as const,
        });
    }
    const reported = input.reportedHeight;
    if (typeof reported === 'number' && Number.isFinite(reported) && reported > 0) {
        return Object.freeze({ height: clamp(reported, input.bounds), source: 'measured' as const });
    }
    return Object.freeze({
        height: clamp(SESSION_BOARD_SEMANTIC_HEIGHTS[input.height.fallback], input.bounds),
        source: 'semantic' as const,
    });
}

/** A transcript reply has no grid cell or pane to fit; its range is the item's own policy. */
const REPLY_BOUNDS: SessionBoardHeightBounds = Object.freeze({ min: 0, max: Number.POSITIVE_INFINITY });

/**
 * Resolve a transcript reply's height from the item's declared policy alone.
 *
 * `fixed` keeps its semantic size; Open in panel shows the rest. `auto` follows the renderer's
 * report exactly, so the body never scrolls inside the transcript's own scroll; a frame that
 * reports its own height keeps the semantic fallback only as the stable box until it does.
 * Content the host lays out natively sizes itself (`null`).
 */
export function resolveSessionBoardReplyHeight(input: Readonly<{
    height: SessionSurfaceItemV1['height'];
    reportedHeight?: number | null;
    measuresIntrinsicHeight: boolean;
}>): SessionBoardResolvedHeight | null {
    const resolved = resolveSessionBoardItemHeight({
        height: input.height,
        reportedHeight: input.reportedHeight,
        bounds: REPLY_BOUNDS,
    });
    if (input.height.mode === 'auto' && resolved.source === 'semantic' && !input.measuresIntrinsicHeight) return null;
    return resolved;
}

/**
 * "Fit content" keeps automatic height and remembers the size closest to what the
 * renderer currently reports as the fallback, so an unmeasured host still lands
 * near the size the person just saw. It never persists pixels.
 */
export function resolveFitContentHeight(
    measuredHeight: number | null | undefined,
): SessionSurfaceItemV1['height'] {
    const entries = Object.entries(SESSION_BOARD_SEMANTIC_HEIGHTS) as ReadonlyArray<
        readonly ['compact' | 'regular' | 'tall', number]
    >;
    if (typeof measuredHeight !== 'number' || !Number.isFinite(measuredHeight) || measuredHeight <= 0) {
        return Object.freeze({ mode: 'auto' as const, fallback: 'regular' as const });
    }
    let closest = entries[0]!;
    for (const entry of entries) {
        if (Math.abs(entry[1] - measuredHeight) < Math.abs(closest[1] - measuredHeight)) closest = entry;
    }
    return Object.freeze({ mode: 'auto' as const, fallback: closest[0] });
}
