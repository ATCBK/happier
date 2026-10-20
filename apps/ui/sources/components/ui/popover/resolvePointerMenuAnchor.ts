import { resolvePointerClientPoint } from '@happier-dev/plugin-ui/presentation';

import type { PopoverAnchor } from './_types';

/**
 * The anchor of a context menu opened from a right click or a long press: a 1 px rect at the event's
 * window point (read by the shared pointer-point owner). Undefined when the event carries no point,
 * so the menu falls back to its trigger.
 */
export function resolvePointerMenuAnchor(event: unknown): PopoverAnchor | undefined {
    const { x, y } = resolvePointerClientPoint(event);
    if (x === null || y === null) return undefined;
    return { kind: 'rect', rect: { left: x, top: y, height: 1 }, coordinateSpace: 'window' };
}
