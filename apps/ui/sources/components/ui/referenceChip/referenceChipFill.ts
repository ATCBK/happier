import { parseThemeColor } from '@/theme/parseThemeColor';

/** The chip's quiet-ink fill (lab CA): the ink it stands in, at low alpha. */
export const REFERENCE_CHIP_FILL_ALPHA = 0.07;

/** A concrete colour for surfaces that cannot derive the fill from the text colour themselves. */
export function referenceChipFill(ink: string): string {
    const color = parseThemeColor(ink);
    return color ? color.alpha(color.alpha() * REFERENCE_CHIP_FILL_ALPHA).rgb().string() : 'transparent';
}
