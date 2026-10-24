import { buildSessionListReachabilityRenderableKey } from '@/sync/domains/state/storage';
import type { useProjectSessions, useSessionListRowRenderablesForItems } from '@/sync/domains/state/storage';
import { normalizeWorkspaceRootPath } from '@/sync/domains/workspaces/workspaceScope';
import { getSessionName } from '@/utils/sessions/sessionUtils';

export type ProjectReviewEvidenceSession = Readonly<{
    sessionId: string;
    label: string;
    latestTurnId?: string | null;
}>;

const NO_EVIDENCE_SESSIONS: readonly ProjectReviewEvidenceSession[] = Object.freeze([]);

/** The review publishes only separately admitted Sessions belonging to this checkout. */
export function projectReviewEvidenceSessions(
    items: ReturnType<typeof useProjectSessions>['items'],
    rows: ReturnType<typeof useSessionListRowRenderablesForItems>,
    scope: Readonly<{ machineId: string; rootPath: string }>,
    previous?: readonly ProjectReviewEvidenceSession[],
): readonly ProjectReviewEvidenceSession[] {
    const previousById = new Map(previous?.map(row => [row.sessionId, row]));
    const evidence = items.flatMap(item => {
        const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId);
        const row = key ? rows.get(key) : null;
        if (!row?.metadata || row.metadata.machineId !== scope.machineId
            || normalizeWorkspaceRootPath(row.metadata.path) !== normalizeWorkspaceRootPath(scope.rootPath)) return [];
        const next = { sessionId: item.sessionId, label: getSessionName(row, item.serverId), latestTurnId: row.latestTurnId };
        const retained = previousById.get(item.sessionId);
        return [retained && retained.label === next.label && retained.latestTurnId === next.latestTurnId ? retained : next];
    });
    // Presence/sequence changes in the roster do not publish new review facts.
    if (previous?.length === evidence.length && evidence.every((entry, index) => entry === previous[index])) return previous;
    return evidence.length === 0 ? NO_EVIDENCE_SESSIONS : evidence;
}
