/**
 * The room below its anchor at which a window-height-bounded popover (a menu, a picker) still opens
 * downward. It only chooses the side; it never limits the popover's height. Pass it as
 * `Popover.placementMinSpace`, otherwise the default (the whole `maxHeightCap`, here the window) fits on
 * neither side and the popover rises over the top of the window instead of growing from its anchor.
 */
export const POPOVER_PREFERRED_ROOM_PX = 320;
