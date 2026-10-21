import { apiSocket } from '@/sync/api/session/apiSocket';
import { subscribeMachineRequestRecovery } from '@/sync/domains/machines/reachability/machineReachability';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/** Existing authenticated Home/Machine reconnect wakes, held only while the caller has demand. */
export function subscribeMachineRpcRecovery(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    expectedAccountId?: string | null;
}>, recover: () => void): () => void {
    const matchesHome = (serverId: string) => areServerProfileIdentifiersEquivalent(
        input.serverId ?? getActiveServerSnapshot().serverId, serverId,
    );
    const matchesAccount = (accountId: string) => !input.expectedAccountId || input.expectedAccountId === accountId;
    const detachFocused = apiSocket.onStatusChange(status => {
        if (status !== 'connected') return;
        // The connection owner clears failed reachability after publishing status.
        void Promise.resolve().then(() => {
            const scope = apiSocket.getMachineRequestScope();
            if (scope && matchesHome(scope.serverId) && matchesAccount(scope.accountId)) recover();
        });
    });
    const detachConcurrent = subscribeHomeAccountChange(event => {
        if (event.source === 'connected' && matchesHome(event.serverId)) recover();
    });
    const detachMachine = subscribeMachineRequestRecovery((scope, machineId) => {
        if (machineId === input.machineId && matchesHome(scope.serverId) && matchesAccount(scope.accountId)) recover();
    });
    return () => { detachFocused(); detachConcurrent(); detachMachine(); };
}
