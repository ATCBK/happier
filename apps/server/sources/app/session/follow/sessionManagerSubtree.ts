import type { Tx } from '@/storage/inTx';
import { hasSessionFollowSessionSource } from './sessionFollowSourceIdentity';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import {
    resolveEffectiveSessionAccessWhere,
    type SessionCollectiveAccessSnapshot,
} from '@/app/session/access/sessionAccessWhere';
import {
    isSessionTranscriptShareable,
    SESSION_TRANSCRIPT_PUBLICATION_SELECT,
} from '@/app/session/sessionTranscriptPublicationPolicy';

/** Structural reachability is not an access grant. Only readable IDs leave this owner. */
export async function readSessionManagedSubtreeSessionIdsInTx(tx: Tx, input: Readonly<{
    accountId: string;
    rootSessionId: string;
    authentication: SessionAccessAuthentication;
    collectiveAccessSnapshot?: SessionCollectiveAccessSnapshot;
}>): Promise<string[]> {
    const access = await resolveEffectiveSessionAccessWhere({
        tx,
        accountId: input.accountId,
        capability: 'readTranscript',
        mode: 'effective_access_v1',
        authentication: input.authentication,
        collectiveAccessSnapshot: input.collectiveAccessSnapshot,
    });
    const root = await tx.session.findFirst({
        where: { AND: [access.where, { id: input.rootSessionId }] },
        select: { id: true, ...SESSION_TRANSCRIPT_PUBLICATION_SELECT },
    });
    if (!root || (root.accountId !== input.accountId && !isSessionTranscriptShareable(root))) return [];

    const reachable = new Set([root.id]);
    let frontier = [root.id];
    while (frontier.length > 0) {
        const edges = await tx.sessionFollowEdge.findMany({
            where: { relation: 'manager', destinationSessionId: { in: frontier } },
            select: { sourceSessionId: true },
        });
        frontier = [];
        for (const edge of edges.filter(hasSessionFollowSessionSource)) {
            if (reachable.has(edge.sourceSessionId)) continue;
            reachable.add(edge.sourceSessionId);
            frontier.push(edge.sourceSessionId);
        }
    }
    // Traverse unreadable intermediates without returning their identity. The
    // canonical access owner also restricts Runner credentials to current_session.
    const rows = await tx.session.findMany({
        where: { AND: [access.where, { id: { in: [...reachable] } }] },
        select: { id: true, ...SESSION_TRANSCRIPT_PUBLICATION_SELECT },
    });
    return rows.filter((row) => row.accountId === input.accountId || isSessionTranscriptShareable(row))
        .map((row) => row.id);
}
