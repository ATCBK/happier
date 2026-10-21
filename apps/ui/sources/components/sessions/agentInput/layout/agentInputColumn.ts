import { layout } from '@/components/ui/layout/layout';

/**
 * The composer's column: its side inset on this window and the width its card is centred in.
 * A host that places its own lines above or below the composer (a label, a status footer) uses the
 * same column so those lines share the card's edges at every width.
 */
export function resolveAgentInputColumn(params: Readonly<{
    screenWidth: number;
    contentPaddingHorizontal?: number;
    /** A number caps the card; `null` lets the host's section size it. */
    maxWidthCap?: number | null;
    compact?: boolean;
}>): Readonly<{ paddingHorizontal: number; maxWidth: number | undefined }> {
    return {
        paddingHorizontal: params.contentPaddingHorizontal ?? (params.screenWidth > 700 ? 16 : 8),
        // A compact composer is contained by its host's section: it takes the section's width, never the
        // centred conversation column.
        maxWidth: typeof params.maxWidthCap === 'number'
            ? params.maxWidthCap
            : params.maxWidthCap === null || params.compact === true ? undefined : layout.maxWidth,
    };
}
