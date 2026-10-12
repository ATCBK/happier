import * as React from 'react';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

/** Data control for the composer's armed route; the Session transition owner supplies applied truth. */
export function useSessionModelUnarm(input: Readonly<{ sessionId: string; serverId: string }>) {
    const { execute, ready } = useMountedActionExecution(input.serverId);
    const unarm = React.useCallback(() => execute('session.model.unarm', { sessionId: input.sessionId }), [execute, input.sessionId]);
    return { unarm, ready };
}
