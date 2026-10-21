import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import { PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';

/** Domain relevance only; each captured Follow lifetime checks the Home and Account. */
export function isSessionFollowAccountChangeRelevant(
    event: HomeAccountChangeEvent,
    sessionIds?: ReadonlySet<string>,
): boolean {
    const ids = event.entityIds;
    const kinds = event.changeKinds;
    // A rule preview admits future sources too; its corpus cannot be restricted to today's matches.
    if (kinds === undefined) return sessionIds === undefined || ids === undefined || ids.some(id => sessionIds.has(id) || id === ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID || id === 'self');
    const projectChanged = sessionIds === undefined && (ids === undefined || ids.some(id => id.startsWith(PROJECT_ACCOUNT_ROWS_KV_PREFIX_V1)));
    if (projectChanged && kinds.some(kind => kind === 'kv')) return true;
    if (kinds.some(kind => kind === 'account')
        && (ids === undefined || ids.includes(ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID) || ids.includes('self') || projectChanged)) return true;
    return kinds.some(kind => kind === 'session' || kind === 'share')
        && (sessionIds === undefined || ids === undefined || ids.some(id => sessionIds.has(id)));
}
