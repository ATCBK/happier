import type { Session } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { normalizeSessionId } from './normalizeSessionId';
import { normalizeTrimmedString } from './listing/normalizeTrimmedString';

/** One Home-qualified live carrier owner, shared by registered readers and store selectors. */
export function selectHomeQualifiedSession(
    state: Readonly<{ sessions: Readonly<Record<string, Session>>; sessionLocalStateScope?: Readonly<{ serverId: string }> | null }>,
    id: string, serverId: string | null | undefined, activeServerId: string | null | undefined,
): Session | null {
    const normalizedServerId = normalizeTrimmedString(serverId);
    if (serverId !== undefined && !normalizedServerId) return null;
    const session = state.sessions[normalizeSessionId(id)] ?? null;
    if (!normalizedServerId || !session) return session;
    if (normalizeTrimmedString(session.serverId)) {
        return areServerProfileIdentifiersEquivalent(session.serverId, normalizedServerId) ? session : null;
    }
    // Older live carriers omitted serverId and belong only to the applied Home.
    return areServerProfileIdentifiersEquivalent(activeServerId, normalizedServerId)
        && areServerProfileIdentifiersEquivalent(state.sessionLocalStateScope?.serverId, normalizedServerId) ? session : null;
}
