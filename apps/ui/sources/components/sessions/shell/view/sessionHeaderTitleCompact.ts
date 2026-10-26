import * as React from 'react';

/**
 * True while the session title and its whole accessory (the role chip) no longer fit on the title
 * line: the accessory then takes its compact form (the role's mark) instead of being cut to a fragment.
 * The Session header's own title fit (`SessionPaneHeader`), beside its one consumer; the band's action
 * fit is `DetailsTabHeaderActionsCompactContext`.
 */
export const SessionHeaderTitleAccessoryCompactContext = React.createContext(false);
