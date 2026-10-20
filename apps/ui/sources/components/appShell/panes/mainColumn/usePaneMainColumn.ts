import * as React from 'react';

export type PaneMainColumnDescriptor = Readonly<{
    hideLabel: string;
    showLabel: string;
    identity: React.ReactNode;
}>;

export type PaneMainColumnState = Readonly<{
    hidden: boolean;
    canHide: boolean;
    folded: boolean;
    labels: Readonly<{ hideLabel: string; showLabel: string }>;
    identity: React.ReactNode;
    setHidden(hidden: boolean): void;
    toggle(): void;
}>;

export const PaneMainColumnContext = React.createContext<PaneMainColumnState | null>(null);

/** Every destination consumes its enclosing measured pane host, including app/plugin pages. */
export function usePaneMainColumn(): PaneMainColumnState | null {
    return React.useContext(PaneMainColumnContext);
}
