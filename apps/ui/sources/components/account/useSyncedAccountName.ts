import {
    areServerAccountScopesEqual,
    type ServerAccountScope,
} from '@/sync/domains/scope/serverAccountScope';
import { getStorage } from '@/sync/domains/state/storageStore';

/**
 * The synced name of exactly this Home's Account (`''` when it has none), or `null` while that
 * Account's profile is not the one in sync. Without a scope it reads the Account in sync now.
 */
export function useSyncedAccountName(
    scope?: ServerAccountScope | null,
): Readonly<{ name: string }> | null {
    const name = getStorage()((state) => {
        const target = scope === undefined ? state.profileScope : scope;
        return target
            && target.accountId
            && areServerAccountScopesEqual(state.profileScope, target)
            && state.profile.id === target.accountId
            ? (state.profile.name ?? '')
            : undefined;
    });
    return name === undefined ? null : { name };
}
