import type { CustomModalChromeCardConfig } from '@/modal/types';

import type { ModalCardDimensionOptions } from './useModalCardDimensions';
import { HAPPIER_CATALOG_LIST_ROLE } from '@happier-dev/plugin-ui/presentation';

/**
 * The command-surface card: Search / ⌘K and Browse external sessions. One owner for its geometry, so
 * every command surface opens in the same frame (width, height cap, radius and shadow from
 * `ModalCardFrame`), placed near the top of the window on web, with the search band as the top of
 * the card (no title band; the title stays the dialog's accessible name).
 */
export const COMMAND_SURFACE_CARD_DIMENSIONS: ModalCardDimensionOptions = Object.freeze({
    // A compact palette for searching everything (lab G1 `.am-card.pal`, about 620 at 1440).
    width: 640,
    maxHeightRatio: 0.7,
    size: 'lg',
});

/** The same card widened for a list with the active row's detail beside it (lab G1s / H1r, about 950). */
export const COMMAND_SURFACE_DETAIL_CARD_DIMENSIONS: ModalCardDimensionOptions = Object.freeze({
    ...COMMAND_SURFACE_CARD_DIMENSIONS,
    width: 960,
});

/**
 * The add-from-a-catalog dialog (add a skill, an MCP server, an agent): one fixed frame for every catalog, whatever
 * the mode, the search or the list ⇄ details split, so the dialog never resizes under the person's hand. Set by the
 * side-by-side with the capabilities lab (sa-A1/A2) and the widget add surface; height follows the window.
 */
export const CATALOG_SURFACE_CARD_DIMENSIONS: ModalCardDimensionOptions = Object.freeze({
    width: 1080,
    maxHeightRatio: 0.88,
    size: 'lg',
});

/**
 * The catalog list beside an open item's details: the Collection's split minima and list share inside
 * `CATALOG_SURFACE_CARD_DIMENSIONS` (the list keeps a readable name, description and facts line; the details take the rest).
 */
/** The catalog list/detail split; its owner is the shared Add body (`HAPPIER_CATALOG_LIST_ROLE`). */
export const CATALOG_SURFACE_LIST_ROLE = HAPPIER_CATALOG_LIST_ROLE;

/** Which frame a command surface shows: the compact palette, or the list with a detail column. */
export type CommandSurfaceLayout = 'compact' | 'detail';

/**
 * The detail column beside a command surface's list (lab G1s code preview, H1r exchange): shown once the
 * card is at least `minListWidthPx` wide, at `widthPx`.
 */
export const COMMAND_SURFACE_DETAIL_PANE = Object.freeze({ minListWidthPx: 720, widthPx: 372 });

/** Web placement of a command surface in the modal shell (`BaseModal` `webPlacement`). */
export const COMMAND_SURFACE_WEB_PLACEMENT = 'top' as const;

export function buildCommandSurfaceCardChrome(params: Readonly<{
    title: string;
    testID?: string;
    closeButtonTestID?: string;
    /** `detail` widens the card for a detail column; the frame animates between the two. Default compact. */
    layout?: CommandSurfaceLayout;
}>): CustomModalChromeCardConfig {
    return {
        kind: 'card',
        header: 'none',
        title: params.title,
        ...(params.testID ? { testID: params.testID } : {}),
        ...(params.closeButtonTestID ? { closeButtonTestID: params.closeButtonTestID } : {}),
        // The list inside is the one scroll owner; the card keeps its height as results change.
        scrollHost: 'body',
        bodyScroll: 'none',
        dimensions: params.layout === 'detail' ? COMMAND_SURFACE_DETAIL_CARD_DIMENSIONS : COMMAND_SURFACE_CARD_DIMENSIONS,
        // On a phone (including a phone-width browser) a command surface fills the screen, with the band at
        // the top and its own way out (lab G1sp); a floating card wastes every side and clips its rows.
        phonePresentation: 'fullscreen',
    };
}
