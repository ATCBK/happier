/** The tallest button drawn in a message's action row. */
const TALLEST_ACTION_PX = 28;

/**
 * The free vertical gap between a message's action row buttons and the next card's first control.
 *
 * The row lives in the band its message reserves below itself (`transcript.messageGap`), which is shorter
 * than its buttons, so they overhang it into the next card's own inset (`space.s6`). Only what is left of
 * that inset is free, and the row's buttons and the next card's first control split it, each reaching half.
 * Both owners read this one number so their hit areas meet without overlapping.
 */
export function resolveMessageActionNeighbourGapPx(theme: Readonly<{
    space: Readonly<{ s6: number }>;
    transcript: Readonly<{ messageGap: number }>;
}>): number {
    const overhang = Math.max(0, (TALLEST_ACTION_PX - theme.transcript.messageGap) / 2);
    return Math.max(0, theme.space.s6 - overhang);
}
