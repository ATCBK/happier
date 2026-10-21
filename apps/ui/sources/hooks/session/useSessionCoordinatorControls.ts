import * as React from 'react';
import { useSession } from '@/sync/domains/state/storage';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { deriveSessionCoordinatorControls, type SessionCoordinatorControls } from '@/sync/ops/sessions/sessionCoordinatorFollowControls';

/** Server-proved, viewer-scoped counts; no client graph or role-based coordinator flag. */
export function useSessionCoordinatorControls(address: SessionAddress): SessionCoordinatorControls {
    const session = useSession(address.sessionId, address.serverId);
    const managedSessions = session?.managedSessions;
    const receivedRuleCount = session?.receivedRuleCount;
    return React.useMemo(() => deriveSessionCoordinatorControls({
        address: { serverId: address.serverId, sessionId: address.sessionId },
        managedSessions, receivedRuleCount,
        receivedRuleCoverage: receivedRuleCount === undefined ? 'unavailable' : 'complete',
    }), [address.serverId, address.sessionId, managedSessions, receivedRuleCount]);
}
