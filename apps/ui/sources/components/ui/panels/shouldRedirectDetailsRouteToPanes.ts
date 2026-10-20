import { resolvePaneLayout, type PaneArrangement } from './paneBreakpoints';

export function shouldRedirectDetailsRouteToPanes(input: Readonly<{
    containerWidthPx: number;
    deviceType: 'phone' | 'tablet';
    multiPaneEnabled: boolean;
    /** Mounted callers consume the measured owner; only standalone routes resolve a window. */
    detailsAvailable?: boolean;
    arrangement?: PaneArrangement;
}>): boolean {
    if (typeof input.detailsAvailable === 'boolean') return input.detailsAvailable;
    const layout = resolvePaneLayout({
        containerWidthPx: input.containerWidthPx,
        deviceType: input.deviceType,
        multiPaneEnabled: input.multiPaneEnabled,
        rightOpen: true,
        detailsOpen: true,
        arrangement: input.arrangement,
    });

    // Only redirect to the in-session panes when the details pane can be docked.
    // If the UI would need to use an overlay anyway, prefer the dedicated screen route.
    return layout.kind !== 'single' && layout.details === 'docked';
}
