import type { ViewStyle } from 'react-native';

import type { ScrollEdgeVisibility } from './useScrollEdgeFades';

type WebMaskStyle = ViewStyle & Readonly<{
    maskImage: string;
    WebkitMaskImage: string;
}>;

type ResolveVerticalScrollEdgeMaskStyleOptions = Readonly<{
    fadeSize?: number;
}>;

type ResolveHorizontalScrollEdgeMaskStyleOptions = ResolveVerticalScrollEdgeMaskStyleOptions & Readonly<{
    /** Clear up to `clearUntilPx`, solid from `solidFromPx`: the leading edge ends between two chips. */
    startClip?: Readonly<{ clearUntilPx: number; solidFromPx: number }>;
    /** Solid up to `solidUntilPx`, clear from `clearFromPx`: the trailing edge ends between two chips. */
    endClip?: Readonly<{ solidUntilPx: number; clearFromPx: number }>;
}>;

const DEFAULT_VERTICAL_SCROLL_EDGE_MASK_SIZE = 18;

export function resolveVerticalScrollEdgeMaskStyle(
    visibility: ScrollEdgeVisibility,
    options: ResolveVerticalScrollEdgeMaskStyleOptions = {},
): WebMaskStyle | null {
    return resolveScrollEdgeMask('to bottom', visibility.top, visibility.bottom, options.fadeSize);
}

/**
 * The same edge mask for a horizontal rail (a composer chip row). It fades the content itself, so it
 * reads on a translucent (glass) surface where a painted fade has no colour to paint. A rail of
 * discrete chips can instead end a visible edge between two chips (`startClip`/`endClip`), so the
 * chips it shows are whole.
 */
export function resolveHorizontalScrollEdgeMaskStyle(
    visibility: ScrollEdgeVisibility,
    options: ResolveHorizontalScrollEdgeMaskStyleOptions = {},
): WebMaskStyle | null {
    const startClip = visibility.left ? options.startClip : undefined;
    const endClip = visibility.right ? options.endClip : undefined;
    if (!startClip && !endClip) {
        return resolveScrollEdgeMask('to right', visibility.left, visibility.right, options.fadeSize);
    }
    const fadeSize = Math.max(0, options.fadeSize ?? DEFAULT_VERTICAL_SCROLL_EDGE_MASK_SIZE);
    const start = startClip
        ? `transparent ${startClip.clearUntilPx}px, black ${startClip.solidFromPx}px`
        : visibility.left ? `transparent 0px, black ${fadeSize}px` : 'black 0px, black 0px';
    const end = endClip
        ? `black ${endClip.solidUntilPx}px, transparent ${endClip.clearFromPx}px`
        : visibility.right ? `black calc(100% - ${fadeSize}px), transparent 100%` : 'black 100%, black 100%';
    const maskImage = `linear-gradient(to right, ${start}, ${end})`;
    return { maskImage, WebkitMaskImage: maskImage };
}

function resolveScrollEdgeMask(
    direction: 'to bottom' | 'to right',
    startVisible: boolean,
    endVisible: boolean,
    fadeSizeInput: number | undefined,
): WebMaskStyle | null {
    if (!startVisible && !endVisible) {
        return null;
    }

    const fadeSize = Math.max(0, fadeSizeInput ?? DEFAULT_VERTICAL_SCROLL_EDGE_MASK_SIZE);
    const startFrom = startVisible ? 'transparent 0px' : 'black 0px';
    const startTo = startVisible ? `black ${fadeSize}px` : 'black 0px';
    const endFrom = endVisible ? `black calc(100% - ${fadeSize}px)` : 'black 100%';
    const endTo = endVisible ? 'transparent 100%' : 'black 100%';
    const maskImage = `linear-gradient(${direction}, ${startFrom}, ${startTo}, ${endFrom}, ${endTo})`;

    return {
        maskImage,
        WebkitMaskImage: maskImage,
    };
}
