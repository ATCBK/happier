import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { FriendsMutationResponseSchema } from '@happier-dev/protocol/social/friends';
import type { UserProfile } from '@/sync/domains/social/friendTypes';
import { requireActionSuccess } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/** Retain the incumbent Friends UI's missing-profile result after Action admission. */
export function readFriendMutationProfile(result: ActionExecuteResult): UserProfile | null {
    if (!result.ok && (result.errorCode === 'not_found' || result.errorCode === 'User not found')) return null;
    requireActionSuccess(result);
    return FriendsMutationResponseSchema.parse(result.result).user;
}
