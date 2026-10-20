import * as React from 'react';

import { AppPaneFileFrontContext } from '../AppPaneContext';
import { DestinationInstanceContext } from '@/components/appShell/workspace/destinationInstanceContext';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';

const subscribeToNothing = () => () => {};

/** Chips observe only whether this exact file is at the front of its retained pane. */
export function useFileTabFront(scopeId: string, path: string): boolean {
    const projection = React.useContext(AppPaneFileFrontContext);
    const read = React.useCallback(() => projection?.read(scopeId, path) ?? false, [projection, scopeId, path]);
    return React.useSyncExternalStore(projection?.subscribe ?? subscribeToNothing, read, read);
}

/**
 * A transcript chip's answer: is this file the front tab of the Session pane the opener would open it in?
 * The scope is derived exactly as `useWorkspaceFileOpener` derives it (Session + retained instance).
 */
export function useSessionFileTabFront(sessionId: string | null | undefined, serverId: string | null | undefined, path: string): boolean {
    const instance = React.useContext(DestinationInstanceContext);
    const scopeId = sessionId ? createSessionPaneScopeId(sessionId, serverId ?? undefined, instance?.tabId ?? null) : '';
    return useFileTabFront(scopeId, path);
}
