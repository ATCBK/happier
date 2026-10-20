import type { HappierCarriedPreviewPlacement } from '@happier-dev/plugin-ui/presentation';

import type { WindowBounds } from '../treeDragDropTypes';

/** The gap the carried card keeps from a region it was asked to stay clear of. */
const CLEARANCE_GAP_PX = 8;

/**
 * A target may name a region the carried card must not cover (the composer's block: its status row
 * and panel are what the drop is about). A card the pointer would put over it sits above it instead,
 * keeping its column and side, or below when there is no room above; otherwise it stays where it is.
 */
export function keepCarriedPreviewClear(input: Readonly<{
    placement: HappierCarriedPreviewPlacement;
    size: Readonly<{ width: number; height: number }>;
    clear: WindowBounds | null;
    viewport: Readonly<{ width: number; height: number }>;
}>): HappierCarriedPreviewPlacement {
    const { placement, size, clear, viewport } = input;
    if (!clear) return placement;
    const covers = placement.left < clear.x + clear.width && clear.x < placement.left + size.width
        && placement.top < clear.y + clear.height && clear.y < placement.top + size.height;
    if (!covers) return placement;
    const above = clear.y - CLEARANCE_GAP_PX - size.height;
    const top = above >= 0 ? above : Math.min(clear.y + clear.height + CLEARANCE_GAP_PX, Math.max(0, viewport.height - size.height));
    return { ...placement, top };
}
