import { ICON_SIZE } from '@/components/ui/icons/Icon';

/** The footer's inset from the sidebar edges; the account area's hover fill sits inside it. */
export const SIDEBAR_FOOTER_PADDING_PX = 8;
/** Each footer icon button: a 28px visible square carrying a sidebar-chrome glyph. */
export const SIDEBAR_FOOTER_ICON_BUTTON_SIZE_PX = 28;
export const SIDEBAR_FOOTER_ICON_GLYPH_SIZE_PX = ICON_SIZE.sm;
/** Between the account area and the first icon, and between icons. */
export const SIDEBAR_FOOTER_GAP_PX = 4;
/**
 * The one width of a rail popover that lays a figure beside each row (Usage's meters, the Machines
 * popover's working counts and summaries): 372px fits a name, its instrument and its value.
 */
export const RAIL_POPOVER_WIDE_WIDTH_PX = 372;

/**
 * How tall a rail roster of many things (the Machines popover) may grow: the height lab `rm` P draws it
 * at, so a fleet with machines that need you is read without scrolling. A shorter window bounds it first.
 */
export const RAIL_POPOVER_ROSTER_MAX_HEIGHT_PX = 720;
