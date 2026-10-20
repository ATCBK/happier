import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import type { HomeAccountChangeEvent } from '@/sync/runtime/orchestration/homeAccountChange';

/** Domain relevance only; each captured Follow lifetime checks the Home and Account. */
export function isSessionFollowAccountChangeRelevant(
    event: HomeAccountChangeEvent,
    sessionIds: ReadonlySet<string>,
): boolean {
    const ids = event.entityIds;
    const kinds = event.changeKinds;
    if (kinds === undefined) return ids === undefined || ids.some(id => sessionIds.has(id) || id === ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID || id === 'self');
    if (kinds.some(kind => kind === 'account')
        && (ids === undefined || ids.includes(ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID) || ids.includes('self'))) return true;
    return kinds.some(kind => kind === 'session' || kind === 'share')
        && (ids === undefined || ids.some(id => sessionIds.has(id)));
}
