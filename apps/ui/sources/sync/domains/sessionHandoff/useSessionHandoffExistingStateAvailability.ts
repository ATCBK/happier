import * as React from 'react';
import { SessionHandoffCapabilityV2Schema } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { supportsExistingSessionHandoffState, type AgentId } from '@happier-dev/agents';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolveSessionHandoffRuntimeConfig } from './sessionHandoffRuntimeConfig';

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
        const probe = async (machineId: string): Promise<boolean> => {
            try {
                const raw = await machineRpcWithServerScope<unknown, Record<string, never>>({
                    serverId, machineId, method: RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET,
                    payload: {}, timeoutMs: resolveSessionHandoffRuntimeConfig().machineRpcPollTimeoutMs,
                });
                const parsed = SessionHandoffCapabilityV2Schema.safeParse(raw);
                return parsed.success && parsed.data.existingState === true;
            } catch {
                // The read has no effects; an unavailable proof keeps the option disabled.
                return false;
            }
        };
        void Promise.all([probe(sourceMachineId), probe(targetMachineId)]).then(([source, target]) => {
            if (!cancelled) setResult({ scope, available: source && target });
        });
        return () => { cancelled = true; };
    }, [agentSupported, scope, serverId, sourceMachineId, targetMachineId]);
    if (!agentSupported) return 'unsupported_agent';
    return result?.scope === scope ? (result.available ? 'available' : 'unavailable') : 'checking';
}
