import * as React from 'react';

/**
 * What the restore chip shows for a hidden main column (lab H1–H3): the host's mark and name, and
 * its live state from the host's own lifecycle projection (`working` ring, `attention` = Needs you).
 */
export type PaneMainIdentity = Readonly<{
    mark?: React.ReactNode;
    name: string;
    state?: 'working' | 'attention';
}>;

export type PaneMainColumnDescriptor = Readonly<{
    hideLabel: string;
    showLabel: string;
    identity: PaneMainIdentity;
}>;

export type PaneMainColumnState = Readonly<{
    hidden: boolean;
    canHide: boolean;
    folded: boolean;
    labels: Readonly<{ hideLabel: string; showLabel: string }>;
    identity: PaneMainIdentity;
    setHidden(hidden: boolean): void;
    toggle(): void;
}>;

export const PaneMainColumnContext = React.createContext<PaneMainColumnState | null>(null);

/** Every destination consumes its enclosing measured pane host, including app/plugin pages. */
export function usePaneMainColumn(): PaneMainColumnState | null {
    return React.useContext(PaneMainColumnContext);
}
