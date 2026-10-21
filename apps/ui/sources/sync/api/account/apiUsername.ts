import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { backoff } from '@/utils/timing/time';
import {
    AccountUsernameCheckRequestV1Schema, AccountUsernameCheckResponseV1Schema,
    AccountUsernameReleaseRequestV1Schema, AccountUsernameReleaseResponseV1Schema,
    AccountUsernameUpdateRequestV1Schema, AccountUsernameUpdateResponseV1Schema,
    type AccountUsernameCheckResponseV1, type AccountUsernameReleaseResponseV1,
} from '@happier-dev/protocol/account/profile';
import { getStorage } from '@/sync/domains/state/storageStore';
import { captureAccountProfileAction, type AccountProfileActionExecution } from './accountProfileActions';

export async function checkAccountUsername(
    credentials: AuthCredentials,
    username: string,
    mounted?: AccountProfileActionExecution,
): Promise<AccountUsernameCheckResponseV1> {
    const input = AccountUsernameCheckRequestV1Schema.parse({ username });
    const action = captureAccountProfileAction(credentials, 'account.username.check', {
        staleScopeError: 'account_username_stale_scope', failureMessage: 'Failed to check username',
        invalidResponseMessage: 'Failed to parse check username response',
    }, mounted);
    const result = AccountUsernameCheckResponseV1Schema.parse(await backoff(() => action.execute(input)));
    action.assertCurrent();
    return result;
}

export async function releaseAccountUsername(
    credentials: AuthCredentials,
    mounted?: AccountProfileActionExecution,
): Promise<AccountUsernameReleaseResponseV1> {
    const action = captureAccountProfileAction(credentials, 'account.username.release', {
        staleScopeError: 'account_username_stale_scope', failureMessage: 'Failed to release username',
        invalidResponseMessage: 'Failed to parse release username response',
    }, mounted);
    const input = AccountUsernameReleaseRequestV1Schema.parse({});
    const result = AccountUsernameReleaseResponseV1Schema.parse(await backoff(() => action.execute(input)));
    action.assertCurrent();
    const state = getStorage().getState();
    state.applyProfile({ ...state.profile, username: result.username });
    return result;
}

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
