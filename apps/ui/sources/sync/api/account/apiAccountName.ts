import {
    AccountNameUpdateRequestV1Schema,
    AccountNameUpdateResponseV1Schema,
    type AccountNameUpdateResponseV1,
} from '@happier-dev/protocol/account/profile';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { getStorage } from '@/sync/domains/state/storageStore';
import { captureAccountProfileAction, type AccountProfileActionExecution } from './accountProfileActions';

/** Save to the captured Account and publish only its validated acknowledgment. */
export async function setAccountName(
    credentials: AuthCredentials,
    name: string | null,
    mounted?: AccountProfileActionExecution,
): Promise<AccountNameUpdateResponseV1> {
    const input = AccountNameUpdateRequestV1Schema.parse({ name });
    const action = captureAccountProfileAction(credentials, 'account.name.set', {
        staleScopeError: 'account_name_stale_scope', failureMessage: 'Failed to set account name',
        invalidResponseMessage: 'Failed to parse set account name response',
    }, mounted);
    const result = AccountNameUpdateResponseV1Schema.parse(await action.execute(input));
    action.assertCurrent();

    const state = getStorage().getState();
    if (result.timestamp >= state.profile.timestamp) {
        state.applyProfile({ ...state.profile, ...result });
    }
    return result;
}
