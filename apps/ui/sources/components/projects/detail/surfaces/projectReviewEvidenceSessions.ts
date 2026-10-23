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
    const evidence = items.flatMap(item => {
        const key = buildSessionListReachabilityRenderableKey(item.serverId, item.sessionId);
        const row = key ? rows.get(key) : null;
        if (!row?.metadata || row.metadata.machineId !== scope.machineId
            || normalizeWorkspaceRootPath(row.metadata.path) !== normalizeWorkspaceRootPath(scope.rootPath)) return [];
        return [{ sessionId: item.sessionId, label: getSessionName(row, item.serverId), latestTurnId: row.latestTurnId }];
    });
    // Presence/sequence changes in the roster do not publish new review facts.
    if (previous?.length === evidence.length && evidence.every((entry, index) => {
        const held = previous[index];
        return held.sessionId === entry.sessionId && held.label === entry.label && held.latestTurnId === entry.latestTurnId;
    })) return previous;
    return evidence.length === 0 ? NO_EVIDENCE_SESSIONS : evidence;
}
