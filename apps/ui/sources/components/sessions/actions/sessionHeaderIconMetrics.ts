import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';
import { Platform } from 'react-native';

import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';

/**
 * One size for the session header's icon actions.
 *
 * This file used to carry three tiers — a base size plus two hand-measured optical corrections for
 * glyphs that painted more ink than their neighbours at the same number. Those corrections existed
 * because the header mixed Ionicons and Octicons: two families drawn to different grids, so matching
 * the numbers did not match the ink.
 *
 * Behind a single-family seam that problem leaves this file entirely. The header asks for one size,
 * and any glyph that still diverges optically is corrected once, per glyph, inside `Icon` — the only
 * place that can reasonably know about a glyph's ink.
 */
export const SESSION_HEADER_ICON_SIZE_PX = ICON_SIZE.md;

/** The drawn square of a direct session-header action: the page's control height. */
export const SESSION_HEADER_ACTION_SIZE_PX = HAPPIER_PAGE_METRICS.controlHeightPx;

/**
 * The press box of a direct session-header action on this device: the drawn square, grown to the
 * platform touch floor only where the primary pointer is a finger.
 */
export function resolveSessionHeaderActionTargetPx(platform: string = Platform.OS): number {
    return Math.max(SESSION_HEADER_ACTION_SIZE_PX, resolveMinimumInteractiveTargetSize(platform));
}
