import * as React from 'react';
import { HappierItemGroupSelectionContext } from '@happier-dev/plugin-ui/presentation';

import { ItemGroupRowPositionBoundary } from '@/components/ui/lists/ItemGroupRowPosition';

const ModalBoundaryContext = React.createContext(false);

export type ModalBoundaryProviderProps = Readonly<{
    children: React.ReactNode;
}>;

/**
 * A modal's content mounts inside its opener's React tree, so it ends the opener's item group here:
 * rows in a dialog never read the selection count, radio group or corners of the group that opened it
 * (a Home hub group with no selectable row left the palette's active row without its fill).
 */
export function ModalBoundaryProvider(props: ModalBoundaryProviderProps) {
    return (
        <ModalBoundaryContext.Provider value={true}>
            <HappierItemGroupSelectionContext.Provider value={null}>
                <ItemGroupRowPositionBoundary>
                    {props.children}
                </ItemGroupRowPositionBoundary>
            </HappierItemGroupSelectionContext.Provider>
        </ModalBoundaryContext.Provider>
    );
}

export function useIsInsideModalBoundary(): boolean {
    return React.useContext(ModalBoundaryContext);
}
