import * as React from 'react';

import type { DetailsOpenerRegion } from '@/components/ui/panels/paneBreakpoints';
import { useDestinationFocus } from '@/components/appShell/workspace/DestinationInstanceHost';
import { readPressFocusReturnTarget, restoreFocusToBestTarget, type FocusReturnTarget } from '@/keyboard/focusReturn';
import { paneRegionFocus, type PaneKeyboardRegion } from './paneRegionFocus';
export { focusPaneRegion } from './paneRegionFocus';

/** The pane column a surface is drawn in: main content, the side column, or Details itself. */
export type PaneRegion = DetailsOpenerRegion | 'details';

const PaneRegionContext = React.createContext<PaneRegion | null>(null);

/**
 * Set by the pane geometry owner around each column, so opening Details records where it was opened
 * from without every caller naming its region.
 */
export function PaneRegionProvider(props: Readonly<{ region: PaneRegion; children: React.ReactNode }>) {
    return <PaneRegionContext.Provider value={props.region}>{props.children}</PaneRegionContext.Provider>;
}

/** `null` outside a pane column host (a full-screen route). */
export function usePaneRegion(): PaneRegion | null {
    return React.useContext(PaneRegionContext);
}

let lastFocusedRegion: PaneKeyboardRegion | null = null;

/** Attach to the existing labelled region View; no wrapper or additional focus listener is needed. */
export function usePaneRegionFocusBoundary(region: PaneKeyboardRegion, visible: boolean) {
    const destinationFocused = useDestinationFocus();
    const node = React.useRef<FocusReturnTarget>(null);
    const lastTarget = React.useRef<FocusReturnTarget>(null);
    const currentVisible = React.useRef(visible);
    currentVisible.current = visible;
    const ref = React.useCallback((value: unknown) => {
        // React Native host refs and DOM elements meet the shared focus-return boundary here.
        node.current = typeof value === 'object' && value !== null ? value as FocusReturnTarget : null;
    }, []);
    const onFocusCapture = React.useCallback((event: unknown) => {
        lastFocusedRegion = region;
        const focusEvent = typeof event === 'object' && event !== null
            ? event as Readonly<{ target?: unknown; nativeEvent?: unknown }> : null;
        lastTarget.current = readPressFocusReturnTarget({ currentTarget: focusEvent?.target, nativeEvent: focusEvent?.nativeEvent });
    }, [region]);
    React.useEffect(() => {
        if (!destinationFocused) return;
        return paneRegionFocus.register(region, () => ({
            visible: currentVisible.current,
            containsFocus: typeof HTMLElement !== 'undefined' && node.current instanceof HTMLElement
                ? node.current.contains(document.activeElement) : lastFocusedRegion === region,
            focus: () => {
                const restored = restoreFocusToBestTarget(lastTarget, node);
                if (restored) lastFocusedRegion = region;
                return restored;
            },
        }));
    }, [destinationFocused, region]);
    return { ref, onFocusCapture, onFocus: onFocusCapture };
}
