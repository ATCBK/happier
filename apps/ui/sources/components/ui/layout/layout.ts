import { Dimensions, Platform } from 'react-native';
import {
    resolveViewportMinEdgePx,
    VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX,
} from '@/utils/platform/viewportClass';
import { useLocalSetting } from '@/sync/store/settingsReadHooks';
import { getStorage } from '@/sync/domains/state/storageStore';
import { PAGE_COLUMN_MAX_WIDTH_PX, resolveContentMaxWidthForMode, type PageColumn } from './contentWidthMode';
import { useContainedPageScope, useListPresentation, usePageColumn } from '@/components/ui/lists/listPresentation';

function readPreferredContentWidthMode(): unknown {
    return getStorage().getState().localSettings.uiContentWidthMode;
}

function resolveConstrainedMaxWidth(params: Readonly<{
    variant: 'header' | 'content';
    preferredContentWidthMode?: unknown;
}>): number {
    const { width, height } = Dimensions.get('window');

    if (Platform.OS !== 'web') {
        const minEdge = resolveViewportMinEdgePx({ width, height });
        // On phones, avoid constraining headers/content to desktop caps.
        if (minEdge < VIEWPORT_CLASS_MIN_EDGE_BREAKPOINTS_PX.tabletMin) return Math.max(width, height);
    }

    return resolveContentMaxWidthForMode(params.preferredContentWidthMode ?? readPreferredContentWidthMode());
}

export const layout = {
    get maxWidth() {
        return resolveConstrainedMaxWidth({ variant: 'content' });
    },
    get headerMaxWidth() {
        return resolveConstrainedMaxWidth({ variant: 'header' });
    },
};

/**
 * The content column's width. On a configuration page it is also capped by the page's column
 * (`PageColumn`), a fixed role: the reading-width preference sizes conversations and floating
 * surfaces, never a page column (a reading column is narrower than every preference; a wide column
 * holds a grid or a library). The viewport fitting owner still applies.
 * Floating surfaces reset to grouped presentation and keep the plain content width.
 */
export function useLayoutMaxWidth(column?: PageColumn | 'conversation'): number {
    const preferredContentWidthMode = useLocalSetting('uiContentWidthMode');
    const presentation = useListPresentation();
    const pageColumn = usePageColumn();
    const isPage = column ? column !== 'conversation' : presentation === 'page';
    // In a contained surface (a card modal) the container is a page list's column (R-APP-7).
    const contained = useContainedPageScope() && column === undefined;
    const contentMaxWidth = resolveConstrainedMaxWidth({ variant: 'content',
        preferredContentWidthMode: isPage ? 'full' : preferredContentWidthMode });
    if (isPage && contained) return Number.POSITIVE_INFINITY;
    return isPage
        ? Math.min(contentMaxWidth, PAGE_COLUMN_MAX_WIDTH_PX[column && column !== 'conversation' ? column : pageColumn])
        : contentMaxWidth;
}

/**
 * Referentially stable `{ maxWidth }` overlay for surfaces whose base style lives
 * in a module-scope `StyleSheet.create` factory. Such a factory evaluates once, so
 * baking `layout.maxWidth` into it freezes the user's content-width preference
 * until the app reloads; composing this overlay keeps the surface reactive without
 * replacing the styled node.
 *
 * The cache is bounded by the small set of resolvable widths (three content-width
 * modes plus the phone fallback edge), and stable identity keeps memoized style
 * arrays from invalidating on every render.
 */
const maxWidthOverlaysByWidth = new Map<number, { readonly maxWidth: number }>();

export function useLayoutMaxWidthStyle(): { readonly maxWidth: number } {
    const maxWidth = useLayoutMaxWidth();
    const cached = maxWidthOverlaysByWidth.get(maxWidth);
    if (cached) return cached;
    const overlay = { maxWidth } as const;
    maxWidthOverlaysByWidth.set(maxWidth, overlay);
    return overlay;
}
