import React from 'react';

/**
 * Whether the pointer is over the row that holds this accessory. An accessory that is quiet until
 * the row is engaged (a per-row menu) reads it here instead of tracking the row itself.
 */
const ItemRowHoverContext = React.createContext(false);

export const ItemRowHoverProvider = ItemRowHoverContext.Provider;

export function useItemRowHovered(): boolean {
    return React.useContext(ItemRowHoverContext);
}
