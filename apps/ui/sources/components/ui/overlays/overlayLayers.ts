/** Body-level floating surfaces share one ordering; nested portals remain inside their parent layer. */
export const POPOVER_Z_INDEX = 200000;
export const MODAL_Z_INDEX_STEP = 10;
export const MODAL_Z_INDEX = POPOVER_Z_INDEX + MODAL_Z_INDEX_STEP;
export const SCREEN_OVERLAY_Z_INDEX = 90000;
