import type { QualifiedProjectKeyV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { matchSessionProjectFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { workspaceRefResolutionContextV1 } from '@/sync/domains/workspaces/workspaceRefs';
import { isSessionAccessOwner } from '@/sync/engine/sessions/normalizeSessionAccessProjection';
import { readSessionListRenderableOwnerMetadataView } from './sessionListRenderableSessionProjection';
import { isUserFacingSession } from './isUserFacingSession';
import type { SessionListRenderableSession } from './sessionListRenderable';

export type ProjectSessionListItem = Extract<SessionListIndexItem, { type: 'session' }>;

/** A projection of admitted membership, never an inventory over the row cache. */
export function projectSessionList(input: Readonly<{
    project: QualifiedProjectKeyV1;
    viewer: ServerAccountScope | null;
    source: readonly SessionListIndexItem[] | null;
    rows: Readonly<Record<string, SessionListRenderableSession>>;
    workspaceRefs?: readonly WorkspaceRefV1[];
}>): Readonly<{ items: readonly ProjectSessionListItem[]; unavailableCount: number }> {
    if (!selectActiveServerAccountScopeForServer(input.viewer, input.project.serverId)) return { items: [], unavailableCount: 0 };
    let unavailableCount = 0;
    const workspaceContext = workspaceRefResolutionContextV1();
    const items = (input.source ?? []).filter((item): item is ProjectSessionListItem => {
        if (item.type !== 'session' || !item.serverId || !areServerProfileIdentifiersEquivalent(item.serverId, input.project.serverId)) return false;
        const row = input.rows[item.sessionId];
        if (!row || !isSessionAccessOwner(row.access, row.accessLevel)
            || (row.owner !== undefined && row.owner !== input.viewer!.accountId)
            || !isUserFacingSession(row)) return false;
        const match = matchSessionProjectFilterV1(row.metadataUnavailable ? null : readSessionListRenderableOwnerMetadataView(row),
            item.serverId, input.project, input.workspaceRefs, workspaceContext);
        if (match === 'unavailable') unavailableCount += 1;
        return match === 'match';
    });
    return { items, unavailableCount };
}
