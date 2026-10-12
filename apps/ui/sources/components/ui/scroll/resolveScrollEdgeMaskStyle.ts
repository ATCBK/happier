import type { ViewStyle } from 'react-native';

import type { ScrollEdgeVisibility } from './useScrollEdgeFades';

type WebMaskStyle = ViewStyle & Readonly<{
    maskImage: string;
    WebkitMaskImage: string;
}>;

type ResolveVerticalScrollEdgeMaskStyleOptions = Readonly<{
    fadeSize?: number;
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
 * reads on a translucent (glass) surface where a painted fade has no colour to paint.
 */
export function resolveHorizontalScrollEdgeMaskStyle(
    visibility: ScrollEdgeVisibility,
    options: ResolveVerticalScrollEdgeMaskStyleOptions = {},
): WebMaskStyle | null {
    return resolveScrollEdgeMask('to right', visibility.left, visibility.right, options.fadeSize);
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
