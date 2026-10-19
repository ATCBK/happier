import type { FrameRect } from '@happier-dev/plugin-ui/presentation';

/** The viewer's gutter from the transcript area's edges (the floating presences' 16). */
export const SESSION_VIEWER_EDGE = 16;
/**
 * The first floating width, as a share of the measured area: a presentation default the person
 * resizes, not a ceiling. The lab's 420 of a ~1000 reading area.
 */
export const DEFAULT_WIDTH_SHARE = 0.42;
/** The live picture's aspect until the source reports its own. */
export const SESSION_VIEWER_DEFAULT_ASPECT = 16 / 10;

/**
 * How far the centred reading column must yield so a settled floating viewer does not cover it.
 * The column keeps its width while the free margin allows, then narrows; zero when it already fits.
 * It never narrows below `columnMinWidth`, the main content's minimum width (the same threshold at
 * which a widened Details pane stops squeezing the main content and overlays it): past that the
 * column stays where it is and the viewer floats over it.
 */
export function resolveSessionViewerReadingInset(
  input: Readonly<{
    areaWidth: number;
    columnMaxWidth: number;
    columnMinWidth: number;
    rect: FrameRect;
  }>,
): Readonly<{ left: number; right: number }> {
  const { areaWidth, columnMaxWidth, rect } = input;
  const leftSide = rect.x + rect.width / 2 < areaWidth / 2;
  // The free edge the reading column may reach, measured from its side of the area.
  const reach = leftSide
    ? areaWidth - (rect.x + rect.width + SESSION_VIEWER_EDGE)
    : rect.x - SESSION_VIEWER_EDGE;
  if (reach <= 0) return { left: 0, right: 0 };
  const column = Math.min(areaWidth, columnMaxWidth);
  const columnEdge = (areaWidth + column) / 2;
  if (columnEdge <= reach) return { left: 0, right: 0 };
  // Recentre in the remaining width: keep the column while (W - P + max) / 2 <= reach, else narrow.
  const keep = areaWidth + columnMaxWidth - 2 * reach;
  const inset = areaWidth - keep >= columnMaxWidth ? keep : areaWidth - reach;
  const yielded = Math.max(0, Math.ceil(inset));
  if (areaWidth - yielded < input.columnMinWidth) return { left: 0, right: 0 };
  return leftSide ? { left: yielded, right: 0 } : { left: 0, right: yielded };
}

/** The narrowest free width beside the frame that still holds the empty state's tile (its scene and headline). */
const CENTRED_MIN_WIDTH = 240;
/** The least height above the frame that holds that tile, header band included. */
const CENTRED_MIN_HEIGHT_ABOVE = 260;

/**
 * Where centred content (the empty Session state) sits so a settled floating viewer never covers it:
 * in the free width beside the frame, or, when that width is too narrow to hold the tile (a Details
 * pane narrows the transcript), at full width above the frame. Unlike the reading column it carries
 * no column minimum. Zero when it already clears, or when neither side can hold it.
 * `contentBottom` is the bottom edge of the transcript's content region (the composer band's top).
 */
export function resolveSessionViewerCentredInset(
  input: Readonly<{ areaWidth: number; contentBottom: number; rect: FrameRect }>,
): Readonly<{ left: number; right: number; bottom: number }> {
  const { areaWidth, contentBottom, rect } = input;
  const none = { left: 0, right: 0, bottom: 0 };
  const leftSide = rect.x + rect.width / 2 < areaWidth / 2;
  const reach = leftSide
    ? areaWidth - (rect.x + rect.width + SESSION_VIEWER_EDGE)
    : rect.x - SESSION_VIEWER_EDGE;
  if (reach >= areaWidth) return none;
  if (reach >= CENTRED_MIN_WIDTH) {
    const yielded = Math.ceil(areaWidth - reach);
    return leftSide ? { left: yielded, right: 0, bottom: 0 } : { left: 0, right: yielded, bottom: 0 };
  }
  const above = rect.y - SESSION_VIEWER_EDGE;
  if (above < CENTRED_MIN_HEIGHT_ABOVE) return none;
  return { left: 0, right: 0, bottom: Math.max(0, Math.ceil(contentBottom - above)) };
}
