import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import { AccountUsernameUpdateRequestV1Schema, AccountUsernameUpdateResponseV1Schema } from '@happier-dev/protocol/account/profile';
import { getStorage } from '@/sync/domains/state/storageStore';
import { captureAccountProfileAction, type AccountProfileActionExecution } from './accountProfileActions';

export async function setAccountUsername(
    credentials: AuthCredentials,
    username: string,
    mounted?: AccountProfileActionExecution,
): Promise<{ username: string }> {
    const input = AccountUsernameUpdateRequestV1Schema.parse({ username });
    const action = captureAccountProfileAction(credentials, 'account.username.set', {
        staleScopeError: 'account_username_stale_scope', failureMessage: 'Failed to set username',
        invalidResponseMessage: 'Failed to parse set username response',
    }, mounted);
    const result = AccountUsernameUpdateResponseV1Schema.parse(await backoff(() => action.execute(input)));
    action.assertCurrent();
    const state = getStorage().getState();
    state.applyProfile({ ...state.profile, username: result.username });
    return result;
}
