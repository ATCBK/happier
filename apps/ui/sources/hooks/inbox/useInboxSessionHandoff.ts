import * as React from 'react';
import type { Session } from '@/sync/domains/state/storageTypes';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { useSessionHandoffAction } from '@/sync/domains/sessionHandoff/useSessionHandoffAction';

/** Mount for the selected Inbox Session's move/repair control, not once per background row. */
export function useInboxSessionHandoff(session: Session | null) {
    const serverId = session?.serverId?.trim() || null;
    const scopedSession = serverId ? session : null;
    const sessionId = scopedSession?.id ?? '';
    const reachableMachineId = useSessionReachableMachineTarget(sessionId, serverId)?.machineId ?? null;
    const sessionHandoffFeatureEnabled = useFeatureEnabled('sessions.handoff');
    const execute = React.useMemo(() => createFrontDoorActionExecute(), []);
    return useSessionHandoffAction({ sessionId, session: scopedSession, serverId, reachableMachineId,
        sessionHandoffFeatureEnabled, execute, placement: 'session_action_menu' });
}
