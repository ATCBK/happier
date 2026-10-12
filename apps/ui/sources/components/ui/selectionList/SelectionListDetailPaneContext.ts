import * as React from 'react';

/**
 * Whether the active row's detail is shown beside the list (`SelectionList` `detailPane` with room for it).
 * A row whose detail would otherwise open inline reads this and keeps itself to one line instead.
 */
export const SelectionListDetailPaneContext = React.createContext(false);
