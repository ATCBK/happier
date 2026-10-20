import type { PaneArrangement, ResolvedPaneLayout } from '@/components/ui/panels/paneBreakpoints';

export function applyMainHiddenLayoutOverride(input: Readonly<{
    mainHidden: boolean;
    arrangement?: PaneArrangement;
    rightOpen: boolean;
    detailsOpen: boolean;
    baseLayout: ResolvedPaneLayout;
}>): ResolvedPaneLayout {
    if (!input.mainHidden) return input.baseLayout;
    if (input.arrangement === 'editor') return input.baseLayout;
    if (!input.rightOpen && !input.detailsOpen) return input.baseLayout;

    // With main hidden, overlay presentations can leave blank space
    // (overlays are positioned relative to the main region). Force visible panes to be docked.
    if (input.rightOpen && input.detailsOpen) {
        return { main: 'docked', kind: 'threePane', right: 'docked', details: 'docked' };
    }
    if (input.rightOpen) {
        return { main: 'docked', kind: 'twoPane', right: 'docked', details: 'hidden' };
    }
    return { main: 'docked', kind: 'twoPane', right: 'hidden', details: 'docked' };
}
