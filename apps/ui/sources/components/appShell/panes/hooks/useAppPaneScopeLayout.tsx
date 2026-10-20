import * as React from 'react';

import type { PaneArrangement, ResolvedPaneLayout } from '@/components/ui/panels/paneBreakpoints';
import type { ResolvedBottomPanePresentation } from '@/components/ui/panels/resolveBottomPaneLayout';

export type AppPaneScopeLayoutState = Readonly<{
    arrangement: PaneArrangement;
    mainHidden: boolean;
    mainDrawerOpen: boolean;
    effectiveDetailsOpen: boolean;
    detailsAvailable: boolean;
    containerWidthPx: number;
    containerHeightPx: number;
    mainRegionWidthPx: number;
    /** Height that remains for main after an open docked bottom pane reserves space. */
    mainRegionHeightPx: number;
    multiPaneEnabled: boolean;
    deviceType: 'phone' | 'tablet';
    layout: ResolvedPaneLayout;
    /** Canonical bottom-pane presentation resolved by the pane host. */
    bottomPresentation: ResolvedBottomPanePresentation;
}>;

const AppPaneScopeLayoutContext = React.createContext<AppPaneScopeLayoutState | null>(null);

export function AppPaneScopeLayoutProvider(
    props: Readonly<{
        value: AppPaneScopeLayoutState;
        children: React.ReactNode;
    }>,
) {
    return (
        <AppPaneScopeLayoutContext.Provider value={props.value}>
            {props.children}
        </AppPaneScopeLayoutContext.Provider>
    );
}

export function useOptionalAppPaneScopeLayout(): AppPaneScopeLayoutState | null {
    return React.useContext(AppPaneScopeLayoutContext);
}
