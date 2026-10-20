import * as React from 'react';

/** Every renderer for one resolver-enabled document shares its workspace-link admission. */
export const MarkdownWorkspaceFileLinksContext = React.createContext(false);
