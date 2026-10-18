import * as React from 'react';
import { supportsExistingSessionHandoffState, type AgentId } from '@happier-dev/agents';

import { probeSessionHandoffCapability } from './probeSessionHandoffCapability';

/** A picker-only read. The daemon independently admits both peers before mutation. */
export function useSessionHandoffExistingStateAvailability(input: Readonly<{
    serverId: string | null;
    sourceMachineId: string | null;
    targetMachineId: string | null;
    agentId: AgentId | null;
}>): 'checking' | 'available' | 'unavailable' | 'unsupported_agent' {
    const { serverId, sourceMachineId, targetMachineId, agentId } = input;
    const agentSupported = supportsExistingSessionHandoffState(agentId);
    const scope = `${serverId ?? ''}:${sourceMachineId ?? ''}:${targetMachineId ?? ''}`;
    const [result, setResult] = React.useState<Readonly<{ scope: string; available: boolean }> | null>(null);
    React.useEffect(() => {
        if (!agentSupported || !sourceMachineId || !targetMachineId || sourceMachineId === targetMachineId) return;
        let cancelled = false;
        void Promise.all([
            probeSessionHandoffCapability({ serverId, machineId: sourceMachineId }),
            probeSessionHandoffCapability({ serverId, machineId: targetMachineId }),
        ]).then(([source, target]) => {
            const available = source.status === 'supported' && source.capability.existingState
                && target.status === 'supported' && target.capability.existingState;
            if (!cancelled) setResult({ scope, available });
        });
        return () => { cancelled = true; };
    }, [agentSupported, scope, serverId, sourceMachineId, targetMachineId]);
    if (!agentSupported) return 'unsupported_agent';
    return result?.scope === scope ? (result.available ? 'available' : 'unavailable') : 'checking';
}
