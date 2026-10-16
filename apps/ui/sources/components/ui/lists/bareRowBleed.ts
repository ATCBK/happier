import * as React from 'react';

/**
 * How far a bare section bleeds past the column by its row inset (0 when it does not). A row inside
 * brings its own inset and lands on the column edge; free content (a button row) has none and reads
 * this to put it back. `ItemGroup` provides it.
 */
export const BareRowBleedContext = React.createContext(0);

export function useBareRowBleedPx(): number {
    return React.useContext(BareRowBleedContext);
}
