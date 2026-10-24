import { useAnimatedReaction } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import {
    TREE_DROP_AUTOSCROLL_EDGE_BAND_PX,
    TREE_DROP_AUTOSCROLL_MAX_SCROLL_PER_FRAME,
} from './treeDropAutoscrollConstants';

type SharedValueLike<T> = { value: T };

export type ResolveTreeDropAutoscrollTargetParams = Readonly<{
    pointerY: number | null;
    viewportTopY: number;
    viewportHeight: number;
    scrollOffsetY: number;
    contentHeight: number;
    edgeBandPx?: number;
    maxScrollPerFrame?: number;
}>;

function clamp(value: number, min: number, max: number): number {
    'worklet';
    return Math.max(min, Math.min(max, value));
}

function resolveStep(distanceIntoBand: number, edgeBandPx: number, maxScrollPerFrame: number): number {
    'worklet';
    const ratio = clamp(distanceIntoBand / edgeBandPx, 0, 1);
    return Math.max(1, Math.ceil(maxScrollPerFrame * ratio * ratio));
}

export function resolveTreeDropAutoscrollTarget(params: ResolveTreeDropAutoscrollTargetParams): number {
    'worklet';
    const pointerY = params.pointerY;
    if (pointerY == null || !Number.isFinite(pointerY)) return params.scrollOffsetY;
    const viewportHeight = params.viewportHeight;
    if (!Number.isFinite(params.viewportTopY) || !Number.isFinite(viewportHeight)
        || !Number.isFinite(params.contentHeight) || viewportHeight <= 0) return params.scrollOffsetY;
    const localY = pointerY - params.viewportTopY;
    if (localY < 0 || localY > viewportHeight) return params.scrollOffsetY;
    const maxScroll = Math.max(0, params.contentHeight - viewportHeight);
    if (maxScroll <= 0) return params.scrollOffsetY;

    const edgeBandPx = Math.max(1, params.edgeBandPx ?? TREE_DROP_AUTOSCROLL_EDGE_BAND_PX);
    const maxScrollPerFrame = Math.max(1, params.maxScrollPerFrame ?? TREE_DROP_AUTOSCROLL_MAX_SCROLL_PER_FRAME);

    if (localY < edgeBandPx) {
        return clamp(
            params.scrollOffsetY - resolveStep(edgeBandPx - localY, edgeBandPx, maxScrollPerFrame),
            0,
            maxScroll,
        );
    }
    if (localY > viewportHeight - edgeBandPx) {
        return clamp(
            params.scrollOffsetY + resolveStep(localY - (viewportHeight - edgeBandPx), edgeBandPx, maxScrollPerFrame),
            0,
            maxScroll,
        );
    }
    // Autoscroll is an edge gesture, not scroll-position reconciliation when
    // content metrics are stale or the list is being measured.
    return params.scrollOffsetY;
}

export type UseTreeDropAutoscrollParams = Readonly<{
    isActive: SharedValueLike<boolean>;
    pointerY: SharedValueLike<number | null>;
    viewportTopY: SharedValueLike<number>;
    viewportHeight: SharedValueLike<number>;
    scrollOffsetY: SharedValueLike<number>;
    contentHeight: SharedValueLike<number>;
    scrollToOffset: (offsetY: number) => void;
    edgeBandPx?: number;
    maxScrollPerFrame?: number;
}>;

export function useTreeDropAutoscroll(params: UseTreeDropAutoscrollParams): void {
    useAnimatedReaction(
        () => {
            if (!params.isActive.value) return null;
            return resolveTreeDropAutoscrollTarget({
                pointerY: params.pointerY.value,
                viewportTopY: params.viewportTopY.value,
                viewportHeight: params.viewportHeight.value,
                scrollOffsetY: params.scrollOffsetY.value,
                contentHeight: params.contentHeight.value,
                edgeBandPx: params.edgeBandPx,
                maxScrollPerFrame: params.maxScrollPerFrame,
            });
        },
        (nextOffset) => {
            if (nextOffset == null || nextOffset === params.scrollOffsetY.value) return;
            params.scrollOffsetY.value = nextOffset;
            scheduleOnRN(params.scrollToOffset, nextOffset);
        },
        [
            params.edgeBandPx,
            params.maxScrollPerFrame,
            params.scrollToOffset,
        ],
    );
}
