import * as React from 'react';

import { AppPaneFileFrontContext } from '../AppPaneContext';

const subscribeToNothing = () => () => {};

/** Chips observe only whether this exact file is at the front of its retained pane. */
export function useFileTabFront(scopeId: string, path: string): boolean {
    const projection = React.useContext(AppPaneFileFrontContext);
    const read = React.useCallback(() => projection?.read(scopeId, path) ?? false, [projection, scopeId, path]);
    return React.useSyncExternalStore(projection?.subscribe ?? subscribeToNothing, read, read);
}
