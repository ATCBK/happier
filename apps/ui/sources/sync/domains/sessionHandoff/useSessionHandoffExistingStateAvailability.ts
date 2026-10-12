import * as React from 'react';
import { SessionHandoffCapabilityV3Schema } from '@happier-dev/protocol/sessions/control/handoff/handoffSchemas';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { resolveSessionHandoffRuntimeConfig } from './sessionHandoffRuntimeConfig';

/** A picker-only read. The daemon independently admits both peers before mutation. */
export function useSessionHandoffExistingStateAvailability(input: Readonly<{
    serverId: string | null;
    sourceMachineId: string | null;
    targetMachineId: string | null;
}>): 'checking' | 'available' | 'unavailable' {
    const { serverId, sourceMachineId, targetMachineId } = input;
    const scope = `${serverId ?? ''}:${sourceMachineId ?? ''}:${targetMachineId ?? ''}`;
    const [result, setResult] = React.useState<Readonly<{ scope: string; available: boolean }> | null>(null);
    React.useEffect(() => {
        if (!sourceMachineId || !targetMachineId || sourceMachineId === targetMachineId) return;
        let cancelled = false;
        const probe = async (machineId: string): Promise<boolean> => {
            try {
                const raw = await machineRpcWithServerScope<unknown, Record<string, never>>({
                    serverId, machineId, method: RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V3_GET,
                    payload: {}, timeoutMs: resolveSessionHandoffRuntimeConfig().machineRpcPollTimeoutMs,
                });
                const parsed = SessionHandoffCapabilityV3Schema.safeParse(raw);
                return parsed.success && parsed.data.existingState === true;
            } catch {
                return false;
            }
        };
        void Promise.all([probe(sourceMachineId), probe(targetMachineId)]).then(([source, target]) => {
            if (!cancelled) setResult({ scope, available: source && target });
        });
        return () => { cancelled = true; };
    }, [scope, serverId, sourceMachineId, targetMachineId]);
    return result?.scope === scope ? (result.available ? 'available' : 'unavailable') : 'checking';
}
