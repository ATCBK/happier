import { useSessionCockpitBottomChromeHeight } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { useIsInsideModalBoundary } from '@/modal/context/ModalBoundaryContext';

/**
 * How far the phone's floating tab bar covers the bottom of the current page, in px (0 when none
 * overlays it, or when the page is inside a modal that covers the bar). The one reading of that
 * reservation: `PagePinnedBar` applies it to a pinned bar, a host that embeds a scrolling view applies
 * it to the view's body.
 */
export function useFloatingChromeClearance(): number {
    const chromeHeight = useSessionCockpitBottomChromeHeight();
    return useIsInsideModalBoundary() ? 0 : chromeHeight;
}
