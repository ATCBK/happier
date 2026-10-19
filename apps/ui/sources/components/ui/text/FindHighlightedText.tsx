import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { HappierFindHighlightedText, type FindMarkStyle, type FindTextRange } from '@happier-dev/plugin-ui/presentation';
import { FIND_MATCH_CURRENT_TEST_ID } from './findMarkTestIds';
export { sliceFindRanges } from '@happier-dev/plugin-ui/presentation';

/**
 * The two marks of every Find surface (Find lab `mark.fd-m`): every match is a soft tint that keeps the text's
 * own colour; the current one is the solid fill with its dark ink, so it reads on any syntax colour and in dark
 * mode. On the web the mark is drawn a hair past the glyphs (rounded, ringed, the current one lifted); native
 * nested text can only take the fill.
 */
/**
 * The mark's ring reaches a hair past the glyphs on the sides only. A spread ring also lifts a pixel above and
 * below the mark, and in a line-clamped snippet a hit on a hidden line then paints that pixel into the last
 * visible line as a stray underline.
 */
function horizontalRing(widthPx: number, color: string): string {
    return `${widthPx}px 0 0 0 ${color}, -${widthPx}px 0 0 0 ${color}`;
}

function resolveFindMarkStyles(theme: ReturnType<typeof useUnistyles>['theme']): Readonly<{ all: FindMarkStyle; current: FindMarkStyle }> {
    const { matchAll, matchCurrent, matchCurrentForeground } = theme.colors.find;
    if (Platform.OS !== 'web') {
        return { all: { backgroundColor: matchAll }, current: { backgroundColor: matchCurrent, color: matchCurrentForeground } };
    }
    return {
        all: { backgroundColor: matchAll, borderRadius: 3, boxShadow: horizontalRing(1, matchAll) },
        current: {
            backgroundColor: matchCurrent,
            color: matchCurrentForeground,
            borderRadius: 3,
            boxShadow: `${horizontalRing(1.5, matchCurrent)}, ${theme.colors.shadowLevels[2].boxShadow}`,
        },
    };
}

/** Half-open UTF-16 display ranges; nested Text preserves parent typography and links. */
export function FindHighlightedText(props: Readonly<{ text: string; ranges?: readonly FindTextRange[]; selectable?: boolean }>) {
    const { theme } = useUnistyles();
    const marks = React.useMemo(() => resolveFindMarkStyles(theme), [theme]);
    return <HappierFindHighlightedText {...props} marks={marks} renderMatch={({ key, text, current, style, selectable }) =>
        <Text key={key} useDefaultTypography={false} selectable={selectable} testID={current ? FIND_MATCH_CURRENT_TEST_ID : 'find-match-all'} style={style}>{text}</Text>} />;
}
