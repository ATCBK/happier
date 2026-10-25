import { Platform } from 'react-native';

import { useFloatingChromeClearance } from '@/components/ui/layout/useFloatingChromeClearance';

/** The breathing room under the last row of a scrolling page: the home-indicator inset on iOS, one gutter elsewhere. */
export const BASE_CONTENT_PADDING_BOTTOM = Platform.select({ ios: 34, default: 16 }) ?? 16;

/**
 * Bottom padding for a page that scrolls its own virtualized list: the base room plus whatever the
 * phone's floating tab bar covers, so the last row (a Load more control) rests above it. `ItemList`
 * applies the same clearance to its scroll body.
 */
export function usePageListBottomPadding(): number {
    return BASE_CONTENT_PADDING_BOTTOM + useFloatingChromeClearance();
}
