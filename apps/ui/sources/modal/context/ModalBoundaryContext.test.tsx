import * as React from 'react';
import { afterEach, expect, it } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ItemGroupSelectionContext } from '@/components/ui/lists/ItemGroup';
import { ItemGroupRowPositionProvider, useItemGroupRowPosition } from '@/components/ui/lists/ItemGroupRowPosition';
import { ModalBoundaryProvider } from './ModalBoundaryContext';

afterEach(standardCleanup);

// A modal opens from inside its opener's React tree (the Home hub's ItemGroup), so its rows would read that
// group's selection count and corners. A single-row hub group then drew no selected row in the palette.
it('keeps the opener’s item group from reaching the rows of a modal', async () => {
    let selection: React.ContextType<typeof ItemGroupSelectionContext> | undefined;
    let position: ReturnType<typeof useItemGroupRowPosition> | undefined;
    function Row() {
        selection = React.useContext(ItemGroupSelectionContext);
        position = useItemGroupRowPosition();
        return React.createElement('Row');
    }
    await renderScreen(
        <ItemGroupSelectionContext.Provider value={{ selectableItemCount: 0 }}>
            <ItemGroupRowPositionProvider value={{ isFirst: true, isLast: true }}>
                <ModalBoundaryProvider><Row /></ModalBoundaryProvider>
            </ItemGroupRowPositionProvider>
        </ItemGroupSelectionContext.Provider>,
    );
    expect(selection).toBeNull();
    expect(position).toBeNull();
});
