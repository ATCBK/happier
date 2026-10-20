import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getStorage } from '@/sync/domains/state/storage';
import { useActiveServerAccountScope } from '@/sync/store/hooks';

/**
 * The turn a one-shot "When this turn ends" binds to: the exact in-progress turn id, read only on the
 * active Home (a bare Session id on another Home could name a different Session). Null when no turn runs.
 */
export function useSessionInProgressTurnId(address: Readonly<{ serverId: string; sessionId: string }>): string | null {
    const scope = useActiveServerAccountScope();
    const active = Boolean(scope && areServerProfileIdentifiersEquivalent(address.serverId, scope.serverId));
    return getStorage()((state) => {
        if (!active) return null;
        const session = state.sessions[address.sessionId];
        return session?.latestTurnStatus === 'in_progress' ? session.latestTurnId ?? null : null;
    });
}
