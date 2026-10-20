import * as React from 'react';

import { Redirect, useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';

/**
 * Deep link to a session's triggers (FIN 04 §3.2, INT §3.1 #3). There is no screen: triggers are a
 * section of how the session is set up, on its Info page (coordination lab P1i), so this opens that
 * page and keeps every other parameter (its Home, an exact-turn prefill) for the section to read.
 */
export function SessionTriggersRoute(): React.ReactElement | null {
    const params = useLocalSearchParams<Record<string, string | string[]>>();
    const sessionId = typeof params.id === 'string' ? params.id : null;
    if (sessionId === null) return null;
    const forwarded: Record<string, string> = {};
    for (const [key, value] of Object.entries(params)) {
        if (key !== 'id' && typeof value === 'string') forwarded[key] = value;
    }
    return <Redirect href={{ pathname: '/session/[id]/info', params: { ...forwarded, id: sessionId } } as never} />;
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { SessionTriggersRoute as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={SessionTriggersRoute} />; }
