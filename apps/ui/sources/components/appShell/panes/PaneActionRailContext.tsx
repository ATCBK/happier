import * as React from 'react';
import { Platform } from 'react-native';

// The desktop rail has 36px controls with 4px of breathing room on either side.
// Native tablets retain their platform's full touch target without overlapping hits.
export const PANE_ACTION_RAIL_WIDTH = Platform.OS === 'web' ? 44 : Platform.OS === 'android' ? 56 : 52;

export const PaneActionRailContext = React.createContext<Readonly<{
    visible: boolean;
    contentWidthPx: number;
    mirrored?: boolean;
    rightPaneHiddenByDetails?: RightPaneHiddenByDetails;
}> | null>(null);

/**
 * Whether Details keeps the side column off screen: `true` when showing it means dismissing Details,
 * `'folded'` when Details opened from main only folded it to its rail, so asking for it again shows it
 * beside Details (which becomes the drawer), and `false` when the side column is free to show.
 */
export type RightPaneHiddenByDetails = boolean | 'folded';

export function usePaneActionRail(): boolean {
    return React.useContext(PaneActionRailContext)?.visible ?? false;
}

export function usePaneContentWidth(): number | undefined {
    return React.useContext(PaneActionRailContext)?.contentWidthPx;
}

export function usePaneActionRailRightPaneHiddenByDetails(): RightPaneHiddenByDetails {
    return React.useContext(PaneActionRailContext)?.rightPaneHiddenByDetails ?? false;
}
