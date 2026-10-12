import * as React from 'react';

import type { SelectedPaneDestinationV1 } from './model/selectedPaneDestination';

/** A constrained layout presents the same accepted pane intent in its navigator. */
export type PanePresentationIntent = Readonly<{
    scopeId: string;
}> & (
    | Readonly<{ pane: 'right'; destination: SelectedPaneDestinationV1 | null }>
    | Readonly<{ pane: 'details' }>
);

const PanePresentationContext = React.createContext<((intent: PanePresentationIntent) => void) | null>(null);

export const PanePresentationProvider = PanePresentationContext.Provider;

export function usePanePresentation(): ((intent: PanePresentationIntent) => void) | null {
    return React.useContext(PanePresentationContext);
}
