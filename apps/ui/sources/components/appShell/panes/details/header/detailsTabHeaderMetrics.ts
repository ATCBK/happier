import { HEADER_BAND_HORIZONTAL_PADDING_PX } from '@/components/ui/layout/headerBand';
import { Typography } from '@/constants/Typography';

/**
 * The measures of a Details tab: the strip its tabs sit on (details lab 2, `dl-strip`) and what
 * sits under the pane header band. The band itself is `PaneHeader`'s.
 */
export const DETAILS_TAB_STRIP_METRICS = Object.freeze({
    heightPx: 42,
    paddingStartPx: 8,
    paddingEndPx: 6,
    tabGapPx: 2,
    tabHeightPx: 28,
    tabRadiusPx: 8,
    tabPaddingStartPx: 9,
    tabPaddingEndPx: 4,
    tabMaxWidthPx: 210,
    tabGlyphPx: 14,
    tabCloseBoxPx: 18,
    /** A tab's pin/close press target under a precise pointer (WCAG 2.2 SC 2.5.8 minimum). */
    tabActionTargetPx: 24,
    tabCloseGlyphPx: 11,
    tabUnsavedDotPx: 7,
    tabLabel: Typography.variant('meta'),
    tabSubtitle: Typography.variant('micro'),
    actionSizePx: 28,
    actionGlyphPx: 15,
});

/**
 * What sits under the pane header band in a Details tab (the view controls row, a body, the diff
 * summary row): aligned on the band's own inset, with the Details text steps for facts and bodies.
 */
type DetailsTabBelowBandStep = Readonly<{
    paddingStartPx: number;
    paddingEndPx: number;
    meta: ReturnType<typeof Typography.variant>;
    body: ReturnType<typeof Typography.variant>;
}>;

/** `pane`: a docked column or drawer. `phone`: the pushed Details route. */
export type DetailsTabHeaderDensity = 'pane' | 'phone';

export const DETAILS_TAB_HEADER_METRICS: Readonly<Record<DetailsTabHeaderDensity, DetailsTabBelowBandStep>> = Object.freeze({
    pane: {
        paddingStartPx: HEADER_BAND_HORIZONTAL_PADDING_PX,
        paddingEndPx: HEADER_BAND_HORIZONTAL_PADDING_PX / 2,
        meta: Typography.variant('meta'),
        body: Typography.variant('body'),
    },
    phone: {
        paddingStartPx: HEADER_BAND_HORIZONTAL_PADDING_PX,
        paddingEndPx: HEADER_BAND_HORIZONTAL_PADDING_PX,
        meta: Typography.variant('body'),
        body: Typography.variant('body'),
    },
});
